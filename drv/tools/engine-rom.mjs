// Store code spans and one common table block; the loader clears omitted RAM.
import { buildClamp, buildRungs } from '../engine/lut.mjs';

export const ENGINE_TABLE_ADDRESS = 0x1100;
export const ENGINE_TABLES = Uint8Array.from([...buildClamp(), ...buildRungs()]);

export function engineCode(bytes, codeEnd) {
  if (!Number.isInteger(codeEnd) || codeEnd <= 0 || codeEnd > ENGINE_TABLE_ADDRESS
      || bytes.length !== ENGINE_TABLE_ADDRESS + ENGINE_TABLES.length)
    throw new Error('invalid engine ROM spans');
  if (bytes.subarray(codeEnd, ENGINE_TABLE_ADDRESS).some(value => value !== 0)
      || !ENGINE_TABLES.every((value, i) => value === bytes[ENGINE_TABLE_ADDRESS + i]))
    throw new Error('engine padding or shared tables differ');
  return bytes.subarray(0, codeEnd);
}

export function cByteArray(name, bytes) {
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16)
    rows.push('    ' + [...bytes.subarray(i, i + 16)]
      .map(value => '0x' + value.toString(16).padStart(2, '0')).join(',') + ',');
  return `static const u8 ${name}[${bytes.length}] = {\n${rows.join('\n')}\n};`;
}
