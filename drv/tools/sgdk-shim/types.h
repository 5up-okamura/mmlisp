/* Stand-in for SGDK's <types.h>, for the glue type-check ONLY
 * (tools/sgdk-lint.mjs).
 *
 * It deliberately mirrors the AWKWARD parts of the real header rather than
 * being a tidy one, because those are exactly what the lint exists to catch:
 *
 *   - `uint8_t`, `int8_t`, `size_t`, `ptrdiff_t` … are #DEFINED as MACROS over
 *     SGDK's own types. That is why <stdint.h> cannot be included after
 *     <genesis.h>, and a friendlier shim hid a real build failure once already.
 *   - `s8` is plain `char`, not `signed char`.
 *   - No standard header is included, so nothing here drags in libc.
 *
 * Width note: the real u32 is `unsigned long` (32-bit on m68k). Here it is
 * `unsigned int`, which is 32-bit on the host too — closer to the target than
 * copying the spelling would be.
 */
#ifndef SGDK_SHIM_TYPES_H
#define SGDK_SHIM_TYPES_H

#define FALSE 0
#define TRUE  1
#define NULL  0

typedef unsigned char  u8;   typedef char   s8;
typedef unsigned short u16;  typedef short  s16;
typedef unsigned int   u32;  typedef int    s32;
typedef volatile u8    vu8;
typedef volatile u16   vu16;
typedef volatile u32   vu32;
typedef u16 bool;

#if !defined(uint8_t) && !defined(__int8_t_defined)
#define uint8_t   u8
#define int8_t    s8
#endif
#if !defined(uint16_t) && !defined(__int16_t_defined)
#define uint16_t  u16
#define int16_t   s16
#endif
#if !defined(uint32_t) && !defined(__int32_t_defined)
#define uint32_t  u32
#define int32_t   s32
#endif
#if !defined(size_t)
#define size_t    u32
#endif
#if !defined(ptrdiff_t)
#define ptrdiff_t u32
#endif

#endif
