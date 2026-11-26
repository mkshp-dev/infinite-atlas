import assert from 'node:assert/strict';
import { buildVegetationChunk } from '../js/vegetation.js';

function posSet(inst) {
  const s = new Set();
  for (let i = 0; i < inst.length; i += 7) s.add(`${inst[i].toFixed(3)},${inst[i+2].toFixed(3)}`);
  return s;
}

function findChunk(seed){ for(let x=-8;x<=8;x++) for(let y=-8;y<=8;y++){ const c=buildVegetationChunk({seed,cx:x,cy:y,chunkSize:512}); if(c.total>10) return {c,x,y}; } throw new Error('no veg'); }
const {c:a,x:cx,y:cy}=findChunk(42);
const b = buildVegetationChunk({ seed: 42, cx, cy, chunkSize: 512 });
assert.equal(a.total, b.total, 'deterministic total');
for (const k of Object.keys(a.instances)) {
  assert.equal(a.instances[k].length, b.instances[k].length, `len ${k}`);
  for (let i = 0; i < a.instances[k].length; i++) assert.equal(a.instances[k][i], b.instances[k][i], `val ${k} ${i}`);
}

const left = buildVegetationChunk({ seed: 42, cx, cy, chunkSize: 512 });
const right = buildVegetationChunk({ seed: 42, cx: cx+1, cy, chunkSize: 512 });
for (const k of Object.keys(left.instances)) {
  const sl = posSet(left.instances[k]);
  const sr = posSet(right.instances[k] || new Float32Array());
  for (const p of sl) assert.ok(!sr.has(p), `duplicate across boundary ${k} ${p}`);
}

const diffSeed = buildVegetationChunk({ seed: 43, cx, cy, chunkSize: 512 });
let changed = diffSeed.total !== a.total;
if (!changed) {
  outer: for (const k of Object.keys(a.instances)) {
    const A=a.instances[k], B=diffSeed.instances[k];
    if (A.length!==B.length) { changed=true; break; }
    for (let i=0;i<A.length;i++) if (A[i]!==B[i]) { changed=true; break outer; }
  }
}
assert.ok(changed, 'seed should change vegetation');

console.log('vegetation-test ok', { total: a.total });
