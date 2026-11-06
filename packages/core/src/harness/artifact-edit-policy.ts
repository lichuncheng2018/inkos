import type {WorkManifest,WorkProfile} from './contracts.js';
import {assertSafeTruthFileName} from './truth-files.js';

/** Storage namespaces maintained by the corresponding domain operations.
 * Other artifacts remain editable when capabilities are combined in a Work. */
export function artifactDomainOwner(work:WorkManifest,path:string,profile:WorkProfile):string|undefined{
  if(profile.capabilityIds.includes('longform')
    &&(path==='source/book.json'||path.startsWith('source/story/')||path.startsWith('source/chapters/')))return 'longform';
  if(profile.capabilityIds.includes('interactive-world')
    &&(path==='source/world.json'||path.startsWith('source/runs/')))return 'interactive-world';
  if(profile.artifactSchemas[path]==='story-graph')return 'interactive-film';
  if(profile.capabilityIds.includes('interactive-film')){
    if(['source/brief.md','source/story-graph.json','source/authoring-state.json','source/delivery-requirements.json','source/interactive-spec.md','source/story-tree.md','source/flags.json','source/flags.md'].includes(path)
      ||path.startsWith('source/snapshots/'))return 'interactive-film';
    // The film bundle's script and images are projections of its interactive
    // spec. A separate script in a composed profile has no such source spec.
    const filmBundle=work.artifacts.some(artifact=>artifact.revisions.some(revision=>revision.id===artifact.currentRevisionId&&revision.path==='source/interactive-spec.md'));
    if(filmBundle&&['source/script.md','source/storyboard.md','source/image-prompts.md','source/assets.json'].includes(path))return 'interactive-film';
  }
  return undefined;
}

export function assertGenericArtifactEditable(work:WorkManifest,path:string,profile:WorkProfile):void{
  const owner=artifactDomainOwner(work,path,profile);
  if(!owner)return;
  const recovery=owner==='longform'?longformEditRecovery(path):{action:'workspace__inspect_work',parameters:{workId:work.id},reason:`Select the ${owner} operation for this artifact. Other independent text artifacts remain editable.`};
  throw Object.assign(new Error(`This artifact is maintained by ${owner} operations; use its domain edit action to preserve associated state. ${recovery.reason}`),{
    code:'ARTIFACT_DOMAIN_ACTION_REQUIRED',path,capabilityId:owner,recovery,
  });
}

function longformEditRecovery(path:string):{readonly action?:string;readonly parameters?:Record<string,unknown>;readonly reason:string}{
  if(path==='source/book.json')return{reason:"Chapter length, range and chapter count are book settings the author changes in Studio. Pass chapterWordCount to longform__write_chapters only for a length requested for that run."};
  if(path.startsWith('source/chapters/')){
    const chapter=/^source\/chapters\/(\d+)_/u.exec(path);
    return{action:'longform__revise_chapter',...(chapter?{parameters:{chapterNumber:Number(chapter[1])}}:{}),
      reason:'Revise the chapter, or use longform__patch_chapter_text for one exact text replacement.'};
  }
  const storyPath=path.slice('source/story/'.length);
  if(/^(state|snapshots|runtime)\//u.test(storyPath))return{action:'longform__resync_chapter_state',reason:'This is chapter state derived from the prose; resync it from the latest chapter.'};
  try{
    const fileName=assertSafeTruthFileName(storyPath);
    return{action:'longform__write_truth_file',parameters:{fileName},reason:fileName==='book_rules.md'?'Replace the whole file and supply bookRulesData.':'Replace the whole file content.'};
  }catch{
    return{action:'longform__revise_foundation',reason:'Revise the foundation with an explicit instruction.'};
  }
}
