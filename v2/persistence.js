import{validateState}from'./core.js';

const clone=x=>structuredClone(x);
export class RevisionConflict extends Error{constructor(){super('revision conflict');this.name='RevisionConflict'}}
export class UnverifiedWrite extends Error{constructor(){super('保存後の再読込検証に失敗しました');this.name='UnverifiedWrite'}}

export function createMemoryStore(initial){
 let value=clone(initial);
 return{
  async read(){return clone(value)},
  async compareAndSwap(expectedRevision,next){
   if(Number(value.revision)!==Number(expectedRevision))throw new RevisionConflict();
   value=clone(next);return clone(value)
  }
 };
}
export async function verifiedWrite(store,next,{expectedRevision,mutationId}){
 validateState(next);
 if(!mutationId||next.lastMutationId!==mutationId)throw new Error('mutationId が保存内容と一致しません');
 if(Number(next.revision)!==Number(expectedRevision)+1)throw new Error('revision が連続していません');
 await store.compareAndSwap(expectedRevision,next);
 const reread=await store.read();
 validateState(reread);
 if(reread.lastMutationId!==mutationId||Number(reread.revision)!==Number(next.revision))throw new UnverifiedWrite();
 return reread;
}
export async function loadVerified(store){const state=await store.read();validateState(state);return state}
