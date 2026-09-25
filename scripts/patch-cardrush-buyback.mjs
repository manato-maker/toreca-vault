import fs from 'node:fs';

const [remotePath, canonicalPath] = process.argv.slice(2);
if (!remotePath || !canonicalPath) throw new Error('remote and canonical source paths are required');
const remote = fs.readFileSync(remotePath, 'utf8');
const canonical = fs.readFileSync(canonicalPath, 'utf8');
const start = 'function findCardrushBuyback_(';
const end = 'function fetchAltemaBuyback_(';
function bounds(source, label) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || b <= a || source.indexOf(start, a + start.length) !== -1 || source.indexOf(end, b + end.length) !== -1) {
    throw new Error(label + ': expected one card buyback function followed by one Altema function');
  }
  return [a, b];
}
const [remoteStart, remoteEnd] = bounds(remote, 'remote');
const [canonicalStart, canonicalEnd] = bounds(canonical, 'canonical');
const replacement = canonical.slice(canonicalStart, canonicalEnd);
if (!replacement.includes('モンスターボールミラー') || !replacement.includes('225/742')) throw new Error('print-aware matching is missing');
const patched = remote.slice(0, remoteStart) + replacement + remote.slice(remoteEnd);
if (patched.slice(0, remoteStart) !== remote.slice(0, remoteStart) || patched.slice(remoteStart + replacement.length) !== remote.slice(remoteEnd)) {
  throw new Error('unrelated remote code would change');
}
fs.writeFileSync(remotePath, patched);
