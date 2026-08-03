/* Stand-in for SGDK's <string.h>, for the glue type-check ONLY.
 *
 * Mirrors the two traits that matter: it types its prototypes with SGDK's own
 * u16/s8 WITHOUT including <types.h> first (so a standalone include fails), and
 * it does NOT declare memcpy/memset — those live in SGDK's <memory.h> with
 * signatures that differ from the standard ones. Anything here that reaches for
 * libc string functions should fail this lint rather than the SGDK build.
 */
#ifndef SGDK_SHIM_STRING_H
#define SGDK_SHIM_STRING_H
u16 strlen(const char *str);
s8  strcmp(const char *a, const char *b);
char *strcpy(char *dst, const char *src);
#endif
