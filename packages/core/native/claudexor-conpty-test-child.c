#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <process.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static int write_all(HANDLE destination, const char *bytes, DWORD length) {
  while (length > 0) {
    DWORD written = 0;
    if (!WriteFile(destination, bytes, length, &written, NULL) || written == 0)
      return 0;
    bytes += written;
    length -= written;
  }
  return 1;
}

static void print_decoded_argv(void) {
  int decoded_argc = 0;
  wchar_t **decoded = CommandLineToArgvW(GetCommandLineW(), &decoded_argc);
  if (decoded == NULL) ExitProcess(70);
  for (int index = 0; index < decoded_argc; index += 1) {
    size_t length = wcslen(decoded[index]);
    printf("ARG|%d|%zu|", index, length);
    for (size_t unit = 0; unit < length; unit += 1)
      printf("%04X", (unsigned)decoded[index][unit]);
    printf("|END\n");
  }
  fflush(stdout);
  LocalFree(decoded);
}

static int parse_exit(const wchar_t *value) {
  wchar_t *end = NULL;
  long parsed = wcstol(value, &end, 10);
  if (end == value || *end != L'\0' || parsed < 0 || parsed > 255) return 2;
  return (int)parsed;
}

static int run_interactive(void) {
  const char first[] = "Sign in at https://accounts.google.com/o/oauth2/";
  const char second[] = "auth?state=claudexor-conpty-fixture\r\n";
  fwrite(first, 1, sizeof(first) - 1, stdout);
  fflush(stdout);
  Sleep(40);
  fwrite(second, 1, sizeof(second) - 1, stdout);
  fflush(stdout);

  /* A successful login must read the submitted code through the console,
   * not fill fgets from raw terminal records stolen from the parent's pipe. */
  DWORD input_mode = 0;
  if (!GetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), &input_mode)) return 4;
  char code[512];
  if (fgets(code, sizeof(code), stdin) == NULL) return 3;
  size_t length = strlen(code);
  while (length > 0 && (code[length - 1] == '\r' || code[length - 1] == '\n'))
    code[--length] = '\0';
  if (strcmp(code, "one-shot-win32-code-77") != 0) return 5;
  printf("\x1b[31mCODE:%s\x1b[0m\r\n", code);
  fflush(stdout);
  return 0;
}

/* Diagnostic sibling of run_interactive: preserve fgets and the console mode,
 * but report only mode/read facts, never the input or an authentication URL. */
static int run_input_probe(void) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  DWORD mode = 0;
  BOOL mode_ok = GetConsoleMode(input, &mode);
  printf("INPUT_READY|%lu|%lu|%d|%lu|%u|%u|END\n",
         (unsigned long)GetCurrentProcessId(), (unsigned long)GetFileType(input),
         mode_ok != FALSE, (unsigned long)mode, GetConsoleCP(), GetConsoleOutputCP());
  fflush(stdout);
  char code[512];
  BOOL read_ok = fgets(code, sizeof(code), stdin) != NULL;
  size_t length = read_ok ? strlen(code) : 0;
  while (length > 0 && (code[length - 1] == '\r' || code[length - 1] == '\n'))
    code[--length] = '\0';
  printf("INPUT_RETURNED|%d|%zu|%d|%d|END\n", read_ok != FALSE,
         length, read_ok && strcmp(code, "one-shot-win32-code-77") == 0,
         ferror(stdin) != 0);
  fflush(stdout);
  return 0; /* Measurement completed; content equality is reported separately. */
}

static int conin_available(void) {
  HANDLE input = CreateFileW(L"CONIN$", GENERIC_READ | GENERIC_WRITE,
                             FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                             OPEN_EXISTING, 0, NULL);
  if (input == INVALID_HANDLE_VALUE) return 0;
  CloseHandle(input);
  return 1;
}

static wchar_t *environment_value(const wchar_t *name) {
  DWORD required = GetEnvironmentVariableW(name, NULL, 0);
  if (required == 0) return NULL;
  wchar_t *value = (wchar_t *)calloc(required, sizeof(wchar_t));
  if (value == NULL) return NULL;
  if (GetEnvironmentVariableW(name, value, required) == 0) {
    free(value);
    return NULL;
  }
  return value;
}

static wchar_t *home_path(const wchar_t *home, const wchar_t *leaf) {
  size_t length = wcslen(home) + 1 + wcslen(leaf) + 1;
  wchar_t *path = (wchar_t *)calloc(length, sizeof(wchar_t));
  if (path == NULL) return NULL;
  if (swprintf_s(path, length, L"%ls\\%ls", home, leaf) < 0) {
    free(path);
    return NULL;
  }
  return path;
}

static int marker_exists(const wchar_t *home, const wchar_t *leaf) {
  wchar_t *path = home_path(home, leaf);
  if (path == NULL) return 0;
  DWORD attributes = GetFileAttributesW(path);
  free(path);
  return attributes != INVALID_FILE_ATTRIBUTES &&
         (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

static int touch_home_marker(const wchar_t *home, const wchar_t *leaf) {
  wchar_t *path = home_path(home, leaf);
  if (path == NULL) return 0;
  HANDLE marker =
      CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                  CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  free(path);
  if (marker == INVALID_HANDLE_VALUE) return 0;
  CloseHandle(marker);
  return 1;
}

static int provider_keys_absent(void) {
  const wchar_t *names[] = {
      L"GEMINI_API_KEY",      L"GOOGLE_API_KEY",   L"OPENAI_API_KEY",
      L"ANTHROPIC_API_KEY",   L"OPENROUTER_API_KEY", L"CLAUDE_API_KEY",
  };
  for (size_t index = 0; index < sizeof(names) / sizeof(names[0]); index += 1) {
    if (GetEnvironmentVariableW(names[index], NULL, 0) != 0) return 0;
  }
  return 1;
}

static int stdin_is_eof_without_blocking(void) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == NULL || input == INVALID_HANDLE_VALUE) return 1;
  DWORD console_mode = 0;
  if (GetConsoleMode(input, &console_mode)) return 0;
  DWORD type = GetFileType(input);
  if (type == FILE_TYPE_PIPE) {
    DWORD available = 0;
    if (PeekNamedPipe(input, NULL, 0, NULL, &available, NULL)) return 0;
    return GetLastError() == ERROR_BROKEN_PIPE ? 1 : 0;
  }
  if (type == FILE_TYPE_CHAR || type == FILE_TYPE_DISK) {
    char byte = 0;
    DWORD read = 0;
    return ReadFile(input, &byte, 1, &read, NULL) && read == 0;
  }
  return type == FILE_TYPE_UNKNOWN && GetLastError() == ERROR_INVALID_HANDLE;
}

static int append_fake_evidence(const wchar_t *home, const char *mode,
                                const char *command, int stdin_eof) {
  wchar_t *path = home_path(home, L".claudexor-agy-fake-evidence.tsv");
  if (path == NULL) return 0;
  HANDLE evidence = CreateFileW(path, FILE_APPEND_DATA,
                                FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                                OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  free(path);
  if (evidence == INVALID_HANDLE_VALUE) return 0;

  wchar_t *user_profile = environment_value(L"USERPROFILE");
  wchar_t *updater = environment_value(L"AGY_CLI_DISABLE_AUTO_UPDATE");
  char line[256];
  int length = snprintf(
      line, sizeof(line), "FAKE\t%s\t%s\t%lu\t%u\t%d\t%d\t%d\t%d\t%d\t%d\n",
      mode, command, (unsigned long)GetCurrentProcessId(),
      (unsigned)GetConsoleCP(), GetConsoleWindow() != NULL ? 1 : 0,
      conin_available(), stdin_eof,
      user_profile != NULL && wcscmp(home, user_profile) == 0 ? 1 : 0,
      updater != NULL && _wcsicmp(updater, L"true") == 0 ? 1 : 0,
      provider_keys_absent());
  free(user_profile);
  free(updater);
  int ok = length > 0 && (size_t)length < sizeof(line) &&
           write_all(evidence, line, (DWORD)length);
  CloseHandle(evidence);
  return ok;
}

static void print_console_state(HANDLE destination, const char *label) {
  HWND window = GetConsoleWindow();
  char line[96];
  int length = snprintf(line, sizeof(line), "%s|%u|%d|%d|%d|END\n", label,
                        (unsigned)GetConsoleCP(), window != NULL ? 1 : 0,
                        window != NULL && IsWindowVisible(window) ? 1 : 0,
                        conin_available());
  if (length > 0 && (size_t)length < sizeof(line))
    (void)write_all(destination, line, (DWORD)length);
}

static int console_control(void) {
  HANDLE captured_output = GetStdHandle(STD_OUTPUT_HANDLE);
  BOOL allocated = AllocConsole();
  print_console_state(captured_output, "CONTROL");
  int available = GetConsoleCP() != 0 && conin_available();
  if (allocated) (void)FreeConsole();
  return available ? 0 : 74;
}

static int console_host(int argc, wchar_t **argv) {
  if (argc < 4) return 76;
  HANDLE captured_output = GetStdHandle(STD_OUTPUT_HANDLE);
  /* Hosted runners may start us in an inherited or CREATE_NO_WINDOW console.
   * Normalize the test host before allocating the classic console that the
   * worker and its client_pty child must inherit. FreeConsole preserves the
   * captured stdout pipe. */
  (void)FreeConsole();
  print_console_state(captured_output, "HOST_BEFORE");
  if (GetConsoleCP() != 0 || conin_available()) return 77;
  if (!AllocConsole()) return 78;
  print_console_state(captured_output, "HOST_AFTER");
  if (GetConsoleCP() == 0 || !conin_available()) {
    (void)FreeConsole();
    return 79;
  }
  intptr_t child = _wspawnv(_P_WAIT, argv[2], (const wchar_t *const *)&argv[2]);
  (void)FreeConsole();
  if (child < 0 || child > 255) return 80;
  return (int)child;
}

static BOOL WINAPI stall_close_handler(DWORD control_type) {
  if (control_type != CTRL_CLOSE_EVENT) return FALSE;
  Sleep(INFINITE);
  return TRUE;
}

static int spawn_descendant(const wchar_t *self, BOOL stream_output,
                            BOOL stall_close) {
  if (stall_close && !SetConsoleCtrlHandler(stall_close_handler, TRUE)) return 75;
  size_t length = wcslen(self) + 32;
  wchar_t *command = (wchar_t *)calloc(length, sizeof(wchar_t));
  if (command == NULL) return 71;
  if (swprintf_s(command, length, L"\"%ls\" --wait", self) < 0) {
    free(command);
    return 72;
  }
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = sizeof(startup);
  if (!CreateProcessW(self, command, NULL, NULL, FALSE, 0, NULL, NULL, &startup,
                      &process)) {
    free(command);
    return 73;
  }
  free(command);
  CloseHandle(process.hThread);
  printf("PIDS|%lu|%lu|END\n", (unsigned long)GetCurrentProcessId(),
         (unsigned long)process.dwProcessId);
  fflush(stdout);
  if (stream_output) {
    for (;;) {
      fputs("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
            stdout);
      fflush(stdout);
      Sleep(1);
    }
  }
  (void)WaitForSingleObject(process.hProcess, INFINITE);
  CloseHandle(process.hProcess);
  return 0;
}

static int run_fake_agy(int argc, wchar_t **argv) {
  if (argc != 5 || wcscmp(argv[1], L"-p") != 0 ||
      (wcscmp(argv[2], L"/model") != 0 &&
       wcscmp(argv[2], L"/quota") != 0) ||
      wcscmp(argv[3], L"--output-format") != 0 ||
      wcscmp(argv[4], L"json") != 0)
    return -1;

  wchar_t *home = environment_value(L"HOME");
  if (home == NULL) return 81;
  const char *command = wcscmp(argv[2], L"/model") == 0 ? "model" : "quota";
  int interactive = conin_available();
  int hanging = !interactive &&
                marker_exists(home, L".claudexor-agy-fake-hang");
  int stdin_eof = interactive ? 0 : stdin_is_eof_without_blocking();
  const char *mode = interactive ? "interactive" : hanging ? "hang" : "print";
  if (!append_fake_evidence(home, mode, command, stdin_eof)) {
    free(home);
    return 82;
  }
  if (interactive &&
      !touch_home_marker(home, L".claudexor-agy-fake-browser-sentinel")) {
    free(home);
    return 83;
  }
  free(home);

  if (hanging) return spawn_descendant(argv[0], FALSE, FALSE);
  if (wcscmp(argv[2], L"/model") == 0) {
    fputs("{\"status\":\"SUCCESS\",\"command\":{\"name\":\"model\",\"data\":{\"id\":\"gemini-3.7-flash-high\"}}}\n",
          stdout);
  } else {
    fputs("{\"status\":\"SUCCESS\",\"command\":{\"name\":\"usage\",\"data\":{\"groups\":[{\"name\":\"Gemini Models\",\"buckets\":[{\"id\":\"gemini-weekly\",\"name\":\"Weekly\",\"window\":\"weekly\",\"remaining_fraction\":0.25,\"reset_time\":\"2030-01-01T00:00:00.000Z\"}]}]}}}\n",
          stdout);
  }
  fflush(stdout);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 2 && wcscmp(argv[1], L"--input-probe") == 0)
    return run_input_probe();
  int fake = run_fake_agy(argc, argv);
  if (fake >= 0) return fake;
  if (argc >= 2 && wcscmp(argv[1], L"--argv") == 0) {
    print_decoded_argv();
    return 0;
  }
  if (argc == 2 && wcscmp(argv[1], L"--interactive") == 0)
    return run_interactive();
  if (argc == 3 && wcscmp(argv[1], L"--exit") == 0)
    return parse_exit(argv[2]);
  if (argc == 2 && wcscmp(argv[1], L"--slow-drain") == 0) {
    for (int block = 0; block < 1024; block += 1) {
      fputs("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
            stdout);
    }
    fflush(stdout);
    return 0;
  }
  if (argc == 2 && wcscmp(argv[1], L"--console-state") == 0) {
    print_console_state(GetStdHandle(STD_OUTPUT_HANDLE), "CONSOLE");
    return 0;
  }
  if (argc == 2 && wcscmp(argv[1], L"--console-control") == 0)
    return console_control();
  if (argc >= 4 && wcscmp(argv[1], L"--console-host") == 0)
    return console_host(argc, argv);
  if (argc == 2 && wcscmp(argv[1], L"--spawn-descendant") == 0)
    return spawn_descendant(argv[0], FALSE, FALSE);
  if (argc == 2 && wcscmp(argv[1], L"--stream-descendant") == 0)
    return spawn_descendant(argv[0], TRUE, FALSE);
  if (argc == 2 && wcscmp(argv[1], L"--ignore-close-stream-descendant") == 0)
    return spawn_descendant(argv[0], TRUE, TRUE);
  if (argc == 2 && wcscmp(argv[1], L"--wait") == 0) {
    for (;;) Sleep(1000);
  }
  return 2;
}
