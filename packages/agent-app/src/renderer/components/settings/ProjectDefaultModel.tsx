import React,{useEffect,useRef,useState} from 'react';
import type {ModelPreference} from '../../../shared/domains/settings-protocol';
import {invoke} from '../../bridge';
import {notifyError} from '../../store';
import {DefaultModelPicker} from './DefaultModelPicker';
import {ProvenanceTag} from './ProvenanceTag';
import {provenance} from './provenance';

/** A Project's default model for new chats started in it; "Use my default" defers to Settings → General.
 *  A failed read shows an error with Retry (never "Use my default", which would be a guess) and nothing can be
 *  set until a read succeeds; only the latest set's response is applied, so quick changes can't land out of order. */
export function ProjectDefaultModel({projectId}:{projectId:string}):React.ReactElement|null {
  const [value,setValue]=useState<ModelPreference|null|undefined>(undefined);
  const [loadError,setLoadError]=useState(false);
  const [attempt,setAttempt]=useState(0);
  const writes=useRef(0);
  useEffect(()=>{
    let live=true;setValue(undefined);setLoadError(false);writes.current++;
    void invoke('settings.projectModel.get',{projectId}).then(result=>{if(live)setValue(result.value);},()=>{if(live)setLoadError(true);});
    return ()=>{live=false;};
  },[projectId,attempt]);
  if(loadError)return <span className="project-default-model is-error" role="alert">
    Default model couldn’t be loaded. <button type="button" className="settings-button secondary" onClick={()=>setAttempt(count=>count+1)}>Retry</button>
  </span>;
  if(value===undefined)return null;
  const change=(next:ModelPreference|null)=>{
    const previous=value,token=++writes.current;setValue(next);
    void invoke('settings.projectModel.set',{projectId,value:next}).then(
      result=>{if(token===writes.current)setValue(result.value);},
      cause=>{if(token===writes.current)setValue(previous);notifyError(cause);});
  };
  return <span className="project-default-model" title="Model new chats in this project start with">
    <DefaultModelPicker label="Project default model" value={value} emptyLabel="Use my default" onChange={change}/>
    <ProvenanceTag provenance={value?provenance('project'):{level:'user',label:'Inherited from your default',canReset:false}} title="Project default model" onReset={()=>change(null)}/>
  </span>;
}
