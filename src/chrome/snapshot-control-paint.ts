import { sampleReadableSnapshot } from "./snapshot-readable";
import { SNAPSHOT_PAINT_SCENE_SOURCE } from "./snapshot-paint-scene";
import { SNAPSHOT_NATIVE_VALUE_EVALUATOR_SOURCE } from "./snapshot-native-value";
import { SNAPSHOT_SELECT_PAINT_EVALUATOR_SOURCE } from "./snapshot-select-paint";

/**
 * Batch both control types in one synchronous frame read. Arguments after the
 * flags are native UA text nodes, then select UA text / selected option pairs,
 * then the select hosts whose open/multiple state must be observed.
 * The caller must verify their CDP identities and re-run the entire batch with
 * a fresh scene and DOM snapshot before delivery. Null entries are uncertain.
 */
export const SNAPSHOT_CONTROL_PAINT_SOURCE = `function(groups, frameUnobscured, noAuthorShadowRoots, ...objects) {
  if (!groups || !Array.isArray(groups.native) || !Array.isArray(groups.selects) || !Array.isArray(groups.selectHosts)) return null;
  const count = groups.native.length, stateOffset = count + groups.selects.length * 2;
  if (objects.length !== stateOffset + groups.selectHosts.length)
    return {scene:null, nativeValues:groups.native.map(() => null), selectValues:groups.selects.map(() => null), selectStates:groups.selectHosts.map(() => null)};
  const selectStates=groups.selectHosts.map((_,index)=>{
    try {
      const host=objects[stateOffset+index];
      if(!host || host.localName!=='select' || !host.isConnected || host.ownerDocument!==this
        || !Number.isSafeInteger(host.size) || host.size<0)return null;
      return {multiple:host.multiple,size:host.size,open:host.matches(':open')};
    }catch{return null;}
  });
  const failures = () => ({scene:null, nativeValues:groups.native.map(() => null), selectValues:groups.selects.map(() => null), selectStates});
  if(frameUnobscured!==true || noAuthorShadowRoots!==true)return failures();
  let painted=groups.painted;
  if(!painted && (count || groups.selects.length)){
    const texts=[...objects.slice(0,count),...groups.selects.map((_,i)=>objects[count+i*2])];
    const roots=[...new Set(texts.map(text=>text.getRootNode()))];
    (${sampleReadableSnapshot.toString()})(1,roots,{shadowRoots:roots},{scope:{contains:()=>true},
      accept:(_nodes,_uncertain,items)=>{painted=new Map(items.map(item=>[item.node,item.text]));}});
  }
  if(!painted)return failures();
  const nativeValues=(${SNAPSHOT_NATIVE_VALUE_EVALUATOR_SOURCE})(this,groups.native,objects.slice(0,count),painted);
  const scene = groups.selects.length ? (${SNAPSHOT_PAINT_SCENE_SOURCE})(this, frameUnobscured, noAuthorShadowRoots,painted) : null;
  if (!scene) return {...failures(),nativeValues};
  return {scene:null,
    nativeValues,
    selectValues:(${SNAPSHOT_SELECT_PAINT_EVALUATOR_SOURCE})(scene, groups.selects, objects.slice(count, stateOffset)), selectStates};
}`;
