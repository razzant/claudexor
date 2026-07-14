#ifdef __APPLE__
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>

enum {
  EXIT_USAGE = 2,
  EXIT_MISSING = 3,
  EXIT_PERMISSION = 4,
  EXIT_PROBE_FAILED = 5
};

int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "--pid") != 0) return EXIT_USAGE;
  errno = 0;
  char *end = NULL;
  long parsed = strtol(argv[2], &end, 10);
  if (errno != 0 || end == argv[2] || *end != '\0' || parsed <= 0 || parsed > INT_MAX) return EXIT_USAGE;

  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  errno = 0;
  int bytes = proc_pidinfo((int)parsed, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (bytes == 0 && errno == ESRCH) return EXIT_MISSING;
  if (bytes == 0 && (errno == EPERM || errno == EACCES)) return EXIT_PERMISSION;
  if (bytes != (int)sizeof(info)) return EXIT_PROBE_FAILED;

  printf("claudexor-process-identity-v2\t%ld\t%" PRIu64 "\t%" PRIu64 "\t%06" PRIu64 "\n",
         parsed, (uint64_t)info.pbi_pgid, (uint64_t)info.pbi_start_tvsec,
         (uint64_t)info.pbi_start_tvusec);
  return 0;
}
#else
#error "claudexor-process-identity.c is a Darwin-only proc_pidinfo helper"
#endif
