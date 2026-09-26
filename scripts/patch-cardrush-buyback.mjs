import fs from 'node:fs';

const [remotePath, canonicalPath] = process.argv.slice(2);
if (!remotePath || !canonicalPath) throw new Error('remote and canonical source paths are required');
let remote = fs.readFileSync(remotePath, 'utf8');
const canonical = fs.readFileSync(canonicalPath, 'utf8');

function replaceRange(remoteSource, canonicalSource, start, end, label, required = []) {
  function bounds(source, sourceLabel) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    if (a < 0 || b < 0 || b <= a || source.indexOf(start, a + start.length) !== -1) {
      throw new Error(sourceLabel + ': expected one ' + label + ' range');
    }
    return [a, b];
  }
  const [ra, rb] = bounds(remoteSource, 'remote');
  const [ca, cb] = bounds(canonicalSource, 'canonical');
  const replacement = canonicalSource.slice(ca, cb);
  for (const marker of required) if (!replacement.includes(marker)) throw new Error(label + ': required marker missing: ' + marker);
  return remoteSource.slice(0, ra) + replacement + remoteSource.slice(rb);
}

remote = replaceRange(remote, canonical,
  'function findCardrushBuyback_(', 'function fetchAltemaBuyback_(', 'card buyback',
  ['モンスターボールミラー','225/742']);

for (const fn of ['runTorecaVaultLotterySync','runTorecaVaultMarketSync']) {
  const marker = 'function ' + fn + '() {';
  const hook = "if(typeof tv2ProcessChatTradeDrafts_==='function')tv2ProcessChatTradeDrafts_();";
  const ri = remote.indexOf(marker), ci = canonical.indexOf(marker);
  if (ci < 0) throw new Error(fn + ': canonical function missing');
  if (ri < 0) continue;
  if (!canonical.slice(ci, ci + 240).includes(hook)) throw new Error(fn + ': canonical hook missing');
  if (!remote.slice(ri, ri + 240).includes(hook)) {
    const at = ri + marker.length;
    remote = remote.slice(0, at) + '\n  ' + hook + remote.slice(at);
  }
}

const sealedStart = 'function refreshSealedMarketCandidates_(';
if (remote.includes('tv2ParseSealedFeed_') && remote.includes('sourceUrl') && remote.includes('x-post')) {
  fs.writeFileSync(remotePath, remote);
  process.exit(0);
}
const remoteSealed = remote.indexOf(sealedStart), canonicalSealed = canonical.indexOf(sealedStart);
if (remoteSealed < 0 || canonicalSealed < 0) throw new Error('sealed market parser missing');
const sealedReplacement = canonical.slice(canonicalSealed);
for (const marker of ['tv2ParseSealedFeed_','sourceUrl','x-post']) if (!sealedReplacement.includes(marker)) throw new Error('sealed market parser marker missing');
remote = remote.slice(0, remoteSealed) + sealedReplacement;

fs.writeFileSync(remotePath, remote);
