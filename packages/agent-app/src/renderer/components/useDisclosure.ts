import {useState} from 'react';
const states=new Map<string,boolean>();
/** Retain child disclosure choices across virtualized/group remounts, bounded. */
export function useDisclosure(key:string,initial=false):[boolean,(value:boolean)=>void]{
 const [open,setOpen]=useState(()=>states.get(key)??initial);
 return [open,value=>{states.delete(key);states.set(key,value);if(states.size>300)states.delete(states.keys().next().value!);setOpen(value);}];
}
