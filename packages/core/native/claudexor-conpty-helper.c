#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/*
 * Narrow Windows pseudoconsole bridge for daemon-hosted setup login.
 *
 * stdout and stdin are the opaque terminal byte stream. stderr is reserved
 * for the bounded control protocol below; it never contains argv, paths,
 * terminal output, URLs, or pasted input.
 */

#define CLAUDEXOR_CONPTY_PROTOCOL "claudexor-conpty-helper-v1"
#define CLAUDEXOR_CONPTY_PROTOCOL_W L"claudexor-conpty-helper-v1"
#define CLAUDEXOR_CONPTY_ARCH "x64"
#define CLAUDEXOR_CONPTY_MAX_COMMAND_LINE 32766u
#define CLAUDEXOR_CONPTY_CHILD_FAILURE_GRACE_MS 250u
#define CLAUDEXOR_CONPTY_CHILD_TERMINATE_WAIT_MS 5000u
#define CLAUDEXOR_CONPTY_OUTPUT_DRAIN_WAIT_MS 5000u

#ifndef PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
#define PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE \
  ProcThreadAttributeValue(22, FALSE, TRUE, FALSE)
#endif

typedef HANDLE CLAUDEXOR_HPCON;
typedef HRESULT(WINAPI *CreatePseudoConsoleFn)(
    COORD, HANDLE, HANDLE, DWORD, CLAUDEXOR_HPCON *);
typedef VOID(WINAPI *ClosePseudoConsoleFn)(CLAUDEXOR_HPCON);

enum HelperExit {
  HELPER_EXIT_OK = 0,
  HELPER_EXIT_VENDOR_LAUNCH_FAILED = 1,
  HELPER_EXIT_USAGE = 2,
  HELPER_EXIT_UNSUPPORTED = 3,
  HELPER_EXIT_TRANSPORT_FAILED = 4
};

enum HelperPhase {
  HELPER_PHASE_API_LOAD = 1,
  HELPER_PHASE_PIPE_CREATE = 2,
  HELPER_PHASE_CONPTY_CREATE = 3,
  HELPER_PHASE_ATTRIBUTE_LIST = 4,
  HELPER_PHASE_COMMAND_LINE = 5,
  HELPER_PHASE_CHILD_CREATE = 6,
  HELPER_PHASE_INPUT_PUMP = 7,
  HELPER_PHASE_OUTPUT_PUMP = 8,
  HELPER_PHASE_CHILD_WAIT = 9,
  HELPER_PHASE_CHILD_EXIT = 10
};

typedef struct ConPtyApi {
  HMODULE kernel32;
  CreatePseudoConsoleFn create;
  ClosePseudoConsoleFn close;
} ConPtyApi;

typedef struct WideBuffer {
  wchar_t *data;
  size_t length;
  size_t capacity;
} WideBuffer;

typedef struct OutputPump {
  HANDLE conpty_output;
  HANDLE destination;
  HANDLE transport_broken;
  DWORD read_error;
  DWORD write_error;
  BOOL discard;
} OutputPump;

static BOOL write_all(HANDLE handle, const void *bytes, DWORD length) {
  const BYTE *cursor = (const BYTE *)bytes;
  DWORD remaining = length;
  while (remaining > 0) {
    DWORD written = 0;
    if (!WriteFile(handle, cursor, remaining, &written, NULL) || written == 0)
      return FALSE;
    cursor += written;
    remaining -= written;
  }
  return TRUE;
}

static void control_error(enum HelperPhase phase, DWORD code) {
  char frame[128];
  int length = snprintf(frame, sizeof(frame), CLAUDEXOR_CONPTY_PROTOCOL
                                               "\terror\t%u\t%lu\n",
                        (unsigned)phase, (unsigned long)code);
  if (length > 0 && (size_t)length < sizeof(frame))
    (void)write_all(GetStdHandle(STD_ERROR_HANDLE), frame, (DWORD)length);
}

static void control_started(DWORD pid) {
  char frame[96];
  int length = snprintf(frame, sizeof(frame), CLAUDEXOR_CONPTY_PROTOCOL
                                               "\tstarted\t%lu\n",
                        (unsigned long)pid);
  if (length > 0 && (size_t)length < sizeof(frame))
    (void)write_all(GetStdHandle(STD_ERROR_HANDLE), frame, (DWORD)length);
}

static BOOL load_conpty_api(ConPtyApi *api) {
  ZeroMemory(api, sizeof(*api));
  api->kernel32 = LoadLibraryExW(L"kernel32.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (api->kernel32 == NULL) return FALSE;
  FARPROC create = GetProcAddress(api->kernel32, "CreatePseudoConsole");
  FARPROC close = GetProcAddress(api->kernel32, "ClosePseudoConsole");
  if (create == NULL || close == NULL) {
    FreeLibrary(api->kernel32);
    ZeroMemory(api, sizeof(*api));
    SetLastError(ERROR_PROC_NOT_FOUND);
    return FALSE;
  }
  _Static_assert(sizeof(create) == sizeof(api->create),
                 "Win32 function pointers must have one representation");
  _Static_assert(sizeof(close) == sizeof(api->close),
                 "Win32 function pointers must have one representation");
  memcpy(&api->create, &create, sizeof(create));
  memcpy(&api->close, &close, sizeof(close));
  return TRUE;
}

static void unload_conpty_api(ConPtyApi *api) {
  if (api->kernel32 != NULL) FreeLibrary(api->kernel32);
  ZeroMemory(api, sizeof(*api));
}

static BOOL buffer_reserve(WideBuffer *buffer, size_t additional) {
  if (additional > CLAUDEXOR_CONPTY_MAX_COMMAND_LINE - buffer->length)
    return FALSE;
  size_t required = buffer->length + additional + 1;
  if (required <= buffer->capacity) return TRUE;
  size_t next = buffer->capacity == 0 ? 256 : buffer->capacity;
  while (next < required) {
    if (next > (CLAUDEXOR_CONPTY_MAX_COMMAND_LINE + 1u) / 2u) {
      next = CLAUDEXOR_CONPTY_MAX_COMMAND_LINE + 1u;
      break;
    }
    next *= 2u;
  }
  wchar_t *grown = (wchar_t *)realloc(buffer->data, next * sizeof(wchar_t));
  if (grown == NULL) return FALSE;
  buffer->data = grown;
  buffer->capacity = next;
  return TRUE;
}

static BOOL buffer_char(WideBuffer *buffer, wchar_t value) {
  if (!buffer_reserve(buffer, 1)) return FALSE;
  buffer->data[buffer->length++] = value;
  buffer->data[buffer->length] = L'\0';
  return TRUE;
}

static BOOL buffer_repeat(WideBuffer *buffer, wchar_t value, size_t count) {
  if (!buffer_reserve(buffer, count)) return FALSE;
  for (size_t index = 0; index < count; index += 1)
    buffer->data[buffer->length++] = value;
  buffer->data[buffer->length] = L'\0';
  return TRUE;
}

/*
 * The one owner of CreateProcessW command-line quoting. The child fixture
 * decodes this with CommandLineToArgvW and proves the round trip in Windows CI.
 */
static BOOL append_quoted_argument(WideBuffer *buffer, const wchar_t *argument) {
  BOOL quote = argument[0] == L'\0' || wcspbrk(argument, L" \t\n\v\"") != NULL;
  if (!quote) {
    size_t length = wcslen(argument);
    if (!buffer_reserve(buffer, length)) return FALSE;
    memcpy(buffer->data + buffer->length, argument, length * sizeof(wchar_t));
    buffer->length += length;
    buffer->data[buffer->length] = L'\0';
    return TRUE;
  }

  if (!buffer_char(buffer, L'\"')) return FALSE;
  size_t slashes = 0;
  for (const wchar_t *cursor = argument;; cursor += 1) {
    if (*cursor == L'\\') {
      slashes += 1;
      continue;
    }
    if (*cursor == L'\"') {
      if (!buffer_repeat(buffer, L'\\', slashes * 2u + 1u) ||
          !buffer_char(buffer, L'\"'))
        return FALSE;
      slashes = 0;
      continue;
    }
    if (*cursor == L'\0') {
      if (!buffer_repeat(buffer, L'\\', slashes * 2u) ||
          !buffer_char(buffer, L'\"'))
        return FALSE;
      return TRUE;
    }
    if (!buffer_repeat(buffer, L'\\', slashes) ||
        !buffer_char(buffer, *cursor))
      return FALSE;
    slashes = 0;
  }
}

static wchar_t *build_command_line(int argc, wchar_t **argv) {
  WideBuffer buffer;
  ZeroMemory(&buffer, sizeof(buffer));
  for (int index = 0; index < argc; index += 1) {
    if (index > 0 && !buffer_char(&buffer, L' ')) goto failure;
    if (!append_quoted_argument(&buffer, argv[index])) goto failure;
  }
  if (buffer.data == NULL) {
    buffer.data = (wchar_t *)calloc(1, sizeof(wchar_t));
    if (buffer.data == NULL) return NULL;
  }
  return buffer.data;

failure:
  free(buffer.data);
  SetLastError(ERROR_INSUFFICIENT_BUFFER);
  return NULL;
}

static DWORD WINAPI output_pump_main(LPVOID opaque) {
  OutputPump *pump = (OutputPump *)opaque;
  BYTE buffer[16 * 1024];
  for (;;) {
    DWORD received = 0;
    if (!ReadFile(pump->conpty_output, buffer, sizeof(buffer), &received, NULL)) {
      DWORD error = GetLastError();
      if (error != ERROR_BROKEN_PIPE && error != ERROR_HANDLE_EOF) {
        pump->read_error = error;
        SetEvent(pump->transport_broken);
      }
      break;
    }
    if (received == 0) break;
    if (!pump->discard && !write_all(pump->destination, buffer, received)) {
      pump->write_error = GetLastError();
      pump->discard = TRUE;
      SetEvent(pump->transport_broken);
      /* Keep draining ConPTY output so pre-24H2 ClosePseudoConsole cannot
       * deadlock on a full synchronous pipe. */
    }
  }
  if (pump->conpty_output != NULL && pump->conpty_output != INVALID_HANDLE_VALUE) {
    CloseHandle(pump->conpty_output);
    pump->conpty_output = INVALID_HANDLE_VALUE;
  }
  return 0;
}

static void close_and_join_output(HANDLE thread, OutputPump *pump) {
  if (thread != NULL) {
    DWORD waited = WaitForSingleObject(thread, CLAUDEXOR_CONPTY_OUTPUT_DRAIN_WAIT_MS);
    if (waited == WAIT_TIMEOUT) {
      /* ClosePseudoConsole is asynchronous on Windows 11 24H2+. A synchronous
       * ReadFile can miss the resulting EOF, so cancel only that stale read
       * after giving pending terminal output a bounded drain window. */
      (void)CancelSynchronousIo(thread);
      (void)WaitForSingleObject(thread, INFINITE);
      if (pump->read_error == ERROR_OPERATION_ABORTED) pump->read_error = 0;
    }
    CloseHandle(thread);
  }
  if (pump->conpty_output != INVALID_HANDLE_VALUE && pump->conpty_output != NULL) {
    CloseHandle(pump->conpty_output);
    pump->conpty_output = INVALID_HANDLE_VALUE;
  }
}

/* A helper-owned transport failure is not a vendor lifetime authority. Give
 * the direct child one bounded grace period, then terminate only its exact
 * process handle before ClosePseudoConsole: pre-24H2 close may synchronously
 * wait for that attached client. This adds no process-name kill or Job Object
 * and, unlike an infinite wait, cannot strand the setup worker. */
static void stop_child_after_transport_failure(HANDLE process) {
  if (process == NULL || process == INVALID_HANDLE_VALUE) return;
  DWORD waited =
      WaitForSingleObject(process, CLAUDEXOR_CONPTY_CHILD_FAILURE_GRACE_MS);
  if (waited == WAIT_OBJECT_0) return;
  (void)TerminateProcess(process, (UINT)HELPER_EXIT_TRANSPORT_FAILED);
  (void)WaitForSingleObject(process,
                            CLAUDEXOR_CONPTY_CHILD_TERMINATE_WAIT_MS);
}

static int run_probe(const ConPtyApi *api) {
  HANDLE input_read = INVALID_HANDLE_VALUE;
  HANDLE input_write = INVALID_HANDLE_VALUE;
  HANDLE output_read = INVALID_HANDLE_VALUE;
  HANDLE output_write = INVALID_HANDLE_VALUE;
  CLAUDEXOR_HPCON hpc = NULL;
  OutputPump output_pump;
  HANDLE output_thread = NULL;
  HANDLE broken = NULL;
  ZeroMemory(&output_pump, sizeof(output_pump));

  if (!CreatePipe(&input_read, &input_write, NULL, 0) ||
      !CreatePipe(&output_read, &output_write, NULL, 0)) {
    control_error(HELPER_PHASE_PIPE_CREATE, GetLastError());
    goto failure;
  }
  COORD size = {80, 25};
  HRESULT result = api->create(size, input_read, output_write, 0, &hpc);
  if (FAILED(result)) {
    control_error(HELPER_PHASE_CONPTY_CREATE, (DWORD)result);
    goto failure;
  }

  /* Creator copies must not keep either channel alive. */
  CloseHandle(input_read);
  input_read = INVALID_HANDLE_VALUE;
  CloseHandle(output_write);
  output_write = INVALID_HANDLE_VALUE;
  CloseHandle(input_write);
  input_write = INVALID_HANDLE_VALUE;

  broken = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (broken == NULL) {
    control_error(HELPER_PHASE_OUTPUT_PUMP, GetLastError());
    goto failure;
  }
  output_pump.conpty_output = output_read;
  output_pump.destination = GetStdHandle(STD_OUTPUT_HANDLE);
  output_pump.transport_broken = broken;
  output_pump.discard = TRUE;
  output_read = INVALID_HANDLE_VALUE;
  output_thread = CreateThread(NULL, 0, output_pump_main, &output_pump, 0, NULL);
  if (output_thread == NULL) {
    control_error(HELPER_PHASE_OUTPUT_PUMP, GetLastError());
    goto failure;
  }

  api->close(hpc);
  hpc = NULL;
  close_and_join_output(output_thread, &output_pump);
  output_thread = NULL;
  CloseHandle(broken);
  if (output_pump.read_error != 0) {
    control_error(HELPER_PHASE_OUTPUT_PUMP, output_pump.read_error);
    return HELPER_EXIT_TRANSPORT_FAILED;
  }
  (void)write_all(GetStdHandle(STD_OUTPUT_HANDLE),
                  CLAUDEXOR_CONPTY_PROTOCOL "\t" CLAUDEXOR_CONPTY_ARCH "\n",
                  (DWORD)(sizeof(CLAUDEXOR_CONPTY_PROTOCOL "\t"
                                CLAUDEXOR_CONPTY_ARCH "\n") - 1));
  return HELPER_EXIT_OK;

failure:
  if (output_thread != NULL) {
    if (hpc != NULL) {
      api->close(hpc);
      hpc = NULL;
    }
    close_and_join_output(output_thread, &output_pump);
  } else if (hpc != NULL) {
    /* With no reader thread, close our reader before HPCON. Otherwise a
     * synchronous ClosePseudoConsole can wait on output nobody can drain. */
    if (output_pump.conpty_output != NULL &&
        output_pump.conpty_output != INVALID_HANDLE_VALUE) {
      CloseHandle(output_pump.conpty_output);
      output_pump.conpty_output = INVALID_HANDLE_VALUE;
    }
    if (output_read != INVALID_HANDLE_VALUE) {
      CloseHandle(output_read);
      output_read = INVALID_HANDLE_VALUE;
    }
    api->close(hpc);
  }
  if (broken != NULL) CloseHandle(broken);
  if (input_read != INVALID_HANDLE_VALUE) CloseHandle(input_read);
  if (input_write != INVALID_HANDLE_VALUE) CloseHandle(input_write);
  if (output_read != INVALID_HANDLE_VALUE) CloseHandle(output_read);
  if (output_write != INVALID_HANDLE_VALUE) CloseHandle(output_write);
  return HELPER_EXIT_TRANSPORT_FAILED;
}

static int run_child(const ConPtyApi *api, int argc, wchar_t **argv) {
  HANDLE conpty_input = INVALID_HANDLE_VALUE;
  HANDLE output_read = INVALID_HANDLE_VALUE;
  HANDLE output_write = INVALID_HANDLE_VALUE;
  CLAUDEXOR_HPCON hpc = NULL;
  STARTUPINFOEXW startup;
  PROCESS_INFORMATION process;
  SIZE_T attribute_bytes = 0;
  wchar_t *command_line = NULL;
  OutputPump output_pump;
  HANDLE output_thread = NULL;
  HANDLE transport_broken = NULL;
  DWORD child_exit = 1;
  int helper_exit = HELPER_EXIT_TRANSPORT_FAILED;
  BOOL child_started = FALSE;

  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  ZeroMemory(&output_pump, sizeof(output_pump));
  startup.StartupInfo.cb = sizeof(startup);
  /* Suppress Windows' implicit duplication of redirected parent std handles.
   * The zeroed handles are filled from the pseudoconsole, not our transport
   * pipes. bInheritHandles=FALSE alone does not prevent that duplication.
   * See microsoft/terminal discussion #15814. */
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;

  conpty_input = GetStdHandle(STD_INPUT_HANDLE);
  if (conpty_input == NULL || conpty_input == INVALID_HANDLE_VALUE) {
    control_error(HELPER_PHASE_PIPE_CREATE, ERROR_INVALID_HANDLE);
    goto cleanup;
  }
  if (!CreatePipe(&output_read, &output_write, NULL, 0)) {
    control_error(HELPER_PHASE_PIPE_CREATE, GetLastError());
    goto cleanup;
  }

  /* The helper is launched with a pipe for stdin. Feed that pipe directly to
   * ConPTY, matching Microsoft's sample topology: a second buffering thread
   * adds no ownership and can delay or strand the terminal input stream. */
  COORD size = {120, 40};
  HRESULT create_result = api->create(size, conpty_input, output_write, 0, &hpc);
  if (FAILED(create_result)) {
    control_error(HELPER_PHASE_CONPTY_CREATE, (DWORD)create_result);
    goto cleanup;
  }

  /* ConPTY owns the session-side references after successful creation. */
  CloseHandle(output_write);
  output_write = INVALID_HANDLE_VALUE;

  InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_bytes);
  if (attribute_bytes == 0) {
    control_error(HELPER_PHASE_ATTRIBUTE_LIST, GetLastError());
    goto cleanup;
  }
  startup.lpAttributeList =
      (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attribute_bytes);
  if (startup.lpAttributeList == NULL) {
    control_error(HELPER_PHASE_ATTRIBUTE_LIST, ERROR_OUTOFMEMORY);
    goto cleanup;
  }
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0,
                                         &attribute_bytes) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                                 PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc,
                                 sizeof(hpc), NULL, NULL)) {
    control_error(HELPER_PHASE_ATTRIBUTE_LIST, GetLastError());
    goto cleanup;
  }

  command_line = build_command_line(argc, argv);
  if (command_line == NULL) {
    control_error(HELPER_PHASE_COMMAND_LINE, GetLastError());
    goto cleanup;
  }

  if (!CreateProcessW(argv[0], command_line, NULL, NULL, FALSE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                      NULL, NULL, &startup.StartupInfo, &process)) {
    control_error(HELPER_PHASE_CHILD_CREATE, GetLastError());
    helper_exit = HELPER_EXIT_VENDOR_LAUNCH_FAILED;
    goto cleanup;
  }
  child_started = TRUE;
  CloseHandle(process.hThread);
  process.hThread = NULL;
  control_started(process.dwProcessId);

  transport_broken = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (transport_broken == NULL) {
    control_error(HELPER_PHASE_OUTPUT_PUMP, GetLastError());
    goto cleanup;
  }

  output_pump.conpty_output = output_read;
  output_read = INVALID_HANDLE_VALUE;
  output_pump.destination = GetStdHandle(STD_OUTPUT_HANDLE);
  output_pump.transport_broken = transport_broken;

  output_thread = CreateThread(NULL, 0, output_pump_main, &output_pump, 0, NULL);
  if (output_thread == NULL) {
    control_error(HELPER_PHASE_OUTPUT_PUMP, GetLastError());
    goto cleanup;
  }
  HANDLE wait_handles[2] = {process.hProcess, transport_broken};
  DWORD waited = WaitForMultipleObjects(2, wait_handles, FALSE, INFINITE);
  if (waited == WAIT_OBJECT_0 + 1) {
    /* The parent stopped consuming output. Teardown on this main thread;
     * the output thread continues draining until ConPTY closes. */
    helper_exit = HELPER_EXIT_TRANSPORT_FAILED;
  } else if (waited != WAIT_OBJECT_0) {
    control_error(HELPER_PHASE_CHILD_WAIT, GetLastError());
    goto cleanup;
  }

  if (waited == WAIT_OBJECT_0 + 1)
    stop_child_after_transport_failure(process.hProcess);
  api->close(hpc);
  hpc = NULL;
  close_and_join_output(output_thread, &output_pump);
  output_thread = NULL;

  if (waited == WAIT_OBJECT_0 + 1) {
    control_error(HELPER_PHASE_OUTPUT_PUMP,
                  output_pump.read_error != 0
                      ? output_pump.read_error
                      : (output_pump.write_error == 0 ? ERROR_BROKEN_PIPE
                                                     : output_pump.write_error));
    goto cleanup;
  }
  if (output_pump.read_error != 0 || output_pump.write_error != 0) {
    control_error(HELPER_PHASE_OUTPUT_PUMP,
                  output_pump.read_error != 0 ? output_pump.read_error
                                              : output_pump.write_error);
    goto cleanup;
  }
  if (!GetExitCodeProcess(process.hProcess, &child_exit) || child_exit == STILL_ACTIVE) {
    control_error(HELPER_PHASE_CHILD_EXIT, GetLastError());
    goto cleanup;
  }
  helper_exit = (int)child_exit;

cleanup:
  if (output_thread == NULL && output_pump.conpty_output != NULL &&
      output_pump.conpty_output != INVALID_HANDLE_VALUE) {
    /* No thread can drain this handle. Break the pipe before closing HPCON so
     * the pre-24H2 synchronous close cannot wait on an unread output buffer. */
    CloseHandle(output_pump.conpty_output);
    output_pump.conpty_output = INVALID_HANDLE_VALUE;
  }
  if (output_thread == NULL && output_read != INVALID_HANDLE_VALUE) {
    CloseHandle(output_read);
    output_read = INVALID_HANDLE_VALUE;
  }
  if (child_started && helper_exit == HELPER_EXIT_TRANSPORT_FAILED)
    stop_child_after_transport_failure(process.hProcess);
  if (hpc != NULL) {
    /* Never close HPCON from the output-reader thread. On pre-24H2 this may
     * block while clients disconnect; the separate output thread keeps the
     * synchronous channel drained. On 24H2+ it may return immediately. */
    api->close(hpc);
    hpc = NULL;
  }
  if (output_thread != NULL) close_and_join_output(output_thread, &output_pump);
  if (process.hProcess != NULL) CloseHandle(process.hProcess);
  if (process.hThread != NULL) CloseHandle(process.hThread);
  if (startup.lpAttributeList != NULL) {
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
  }
  free(command_line);
  if (transport_broken != NULL) CloseHandle(transport_broken);
  if (output_read != INVALID_HANDLE_VALUE) CloseHandle(output_read);
  if (output_write != INVALID_HANDLE_VALUE) CloseHandle(output_write);
  return helper_exit;
}

int wmain(int argc, wchar_t **argv) {
  ConPtyApi api;
  if (argc == 2 && wcscmp(argv[1], L"--probe") == 0) {
    if (!load_conpty_api(&api)) {
      control_error(HELPER_PHASE_API_LOAD, GetLastError());
      return HELPER_EXIT_UNSUPPORTED;
    }
    int result = run_probe(&api);
    unload_conpty_api(&api);
    return result;
  }
  if (argc < 3 || wcscmp(argv[1], L"--") != 0 || argv[2][0] == L'\0')
    return HELPER_EXIT_USAGE;

  if (!load_conpty_api(&api)) {
    control_error(HELPER_PHASE_API_LOAD, GetLastError());
    return HELPER_EXIT_UNSUPPORTED;
  }
  int result = run_child(&api, argc - 2, argv + 2);
  unload_conpty_api(&api);
  return result;
}
