/* Minimal stand-in for SGDK's <types.h>, for the glue type-check ONLY
 * (tools/sgdk-lint.mjs). It models the type names and nothing else. */
#ifndef SGDK_SHIM_TYPES_H
#define SGDK_SHIM_TYPES_H
#include <stdint.h>
#include <stddef.h>
typedef uint8_t u8;   typedef int8_t  s8;
typedef uint16_t u16; typedef int16_t s16;
typedef uint32_t u32; typedef int32_t s32;
typedef volatile uint8_t vu8;
typedef volatile uint16_t vu16;
typedef u16 bool;
#define TRUE 1
#define FALSE 0
#endif
