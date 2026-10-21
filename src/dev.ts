import { spawn } from "node:child_process";
const children=["src/server.ts"].map((entry)=>spawn(process.execPath,["--env-file-if-exists=.env",entry],{stdio:"inherit",env:{...process.env,OPENSSL_CONF:"/dev/null"}}));
function stop(){for(const child of children)child.kill("SIGTERM");}
process.on("SIGINT",()=>{stop();process.exit(0);});process.on("SIGTERM",()=>{stop();process.exit(0);});
for(const child of children)child.on("exit",(code)=>{if(code&&code!==0){stop();process.exit(code);}});
