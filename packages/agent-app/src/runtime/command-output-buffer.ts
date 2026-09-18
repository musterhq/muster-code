export const MAX_COMMAND_OUTPUT = 131072;
export interface CommandOutput {output:string;truncated:boolean}
export function appendCommandOutput(previous:CommandOutput,delta:string):CommandOutput {
 return {output:(previous.output+delta.slice(-MAX_COMMAND_OUTPUT)).slice(-MAX_COMMAND_OUTPUT),truncated:previous.truncated||previous.output.length+delta.length>MAX_COMMAND_OUTPUT};
}
export function finishCommandOutput(previous:CommandOutput,finalOutput:string|null):CommandOutput {
 if(finalOutput===null||(previous.output&&previous.output.endsWith(finalOutput)))return previous;
 return {output:finalOutput.slice(-MAX_COMMAND_OUTPUT),truncated:finalOutput.length>MAX_COMMAND_OUTPUT};
}
