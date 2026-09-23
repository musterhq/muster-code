/**
 * CR-18 "Integrated terminal shell": zsh, bash, fish or a custom absolute path. Named shells resolve through
 * /etc/shells first, then the usual install locations; a missing or non-executable choice falls back to the
 * login shell, and the caller is told so.
 */
import {accessSync,constants,readFileSync,statSync} from 'node:fs';
import {basename,isAbsolute} from 'node:path';
import {TERMINAL_SHELL_NAMES,type TerminalShellName,type TerminalShellOption} from '../shared/domains/settings-protocol.ts';

/** The user's login shell ($SHELL), else the platform default. */
export function loginShell():string {
  const shell=process.env.SHELL;
  return shell&&isAbsolute(shell)&&!shell.includes('\0')?shell:process.platform==='darwin'?'/bin/zsh':'/bin/bash';
}
const COMMON_DIRS=['/bin','/usr/bin','/usr/local/bin','/opt/homebrew/bin','/opt/local/bin','/run/current-system/sw/bin'];
const LABELS:Record<TerminalShellName,string>={zsh:'zsh',bash:'bash',fish:'fish'};

export interface ShellProbe {executable(path:string):boolean;etcShells():string[]}
export const systemProbe:ShellProbe={
  executable(path){try{return statSync(path).isFile()&&(accessSync(path,constants.X_OK),true);}catch{return false;}},
  etcShells(){try{return readFileSync('/etc/shells','utf8').split('\n').map(line=>line.trim()).filter(line=>line.startsWith('/')&&!line.includes('\0'));}catch{return [];}},
};

/** Where a named shell lives on this machine, or undefined. */
export function findShell(name:TerminalShellName,probe:ShellProbe=systemProbe):string|undefined {
  const candidates=[...probe.etcShells().filter(path=>basename(path)===name),...COMMON_DIRS.map(dir=>`${dir}/${name}`)];
  return [...new Set(candidates)].find(path=>probe.executable(path));
}

/** Shells the Preferences picker offers (the named ones that exist). Empty means "No shells available". */
export function availableShells(probe:ShellProbe=systemProbe):TerminalShellOption[] {
  return TERMINAL_SHELL_NAMES.flatMap(name=>{const path=findShell(name,probe);return path?[{id:name,label:LABELS[name],path}]:[];});
}

export function validCustomShell(path:string,probe:ShellProbe=systemProbe):boolean {
  return isAbsolute(path)&&!path.includes('\0')&&path.length<=1024&&probe.executable(path);
}

/** The executable a new terminal launches for this preference. `fallback` is set when the choice was unavailable. */
export function resolveTerminalShell(preference:string|undefined,loginShell:()=>string,probe:ShellProbe=systemProbe):{file:string;fallback?:string} {
  if(!preference||preference==='system')return {file:loginShell()};
  if((TERMINAL_SHELL_NAMES as readonly string[]).includes(preference)){
    const found=findShell(preference as TerminalShellName,probe);
    return found?{file:found}:{file:loginShell(),fallback:`${preference} is not installed; using the login shell.`};
  }
  return validCustomShell(preference,probe)?{file:preference}:{file:loginShell(),fallback:`${preference} is not an executable shell; using the login shell.`};
}

/** Login flag per shell: every supported shell accepts `-l`; an unknown custom shell gets none. */
export function shellArgs(file:string):string[] {
  return ['zsh','bash','fish','sh','ksh','dash','tcsh','csh','nu'].includes(basename(file))?['-l']:[];
}
