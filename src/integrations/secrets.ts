import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
export type Ciphertext={iv:string;tag:string;ciphertext:string};
function key(){const secret=process.env.TWIN_ENCRYPTION_KEY;if(!secret||secret.length<24)throw new Error("ENCRYPTION_NOT_CONFIGURED");return createHash("sha256").update(secret).digest();}
export function encryptSecret(value:string):Ciphertext{const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key(),iv);const ciphertext=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return{iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")};}
export function decryptSecret(value:Ciphertext){const decipher=createDecipheriv("aes-256-gcm",key(),Buffer.from(value.iv,"base64"));decipher.setAuthTag(Buffer.from(value.tag,"base64"));return Buffer.concat([decipher.update(Buffer.from(value.ciphertext,"base64")),decipher.final()]).toString("utf8");}
export function encryptionReady(){return Boolean(process.env.TWIN_ENCRYPTION_KEY&&process.env.TWIN_ENCRYPTION_KEY.length>=24);}
