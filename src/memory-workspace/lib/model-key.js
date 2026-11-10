import { createHmac, randomBytes } from 'node:crypto'
/** Native credential owner. Values never enter configuration, model prompts or receipts. */
export function createModelKeyStore(credentials,key){
  const salt=randomBytes(32),revision=record=>createHmac('sha256',salt).update(JSON.stringify(record??null)).digest('hex')
  const valid=value=>typeof value==='string'&&/^sk-or-[A-Za-z0-9._-]{8,4090}$/u.test(value)
  const read=async()=>typeof credentials?.readRecord==='function'?credentials.readRecord(key):null
  return{
    async status(){const record=await read();return{configured:record?.kind==='api-key'&&valid(record.key),revision:revision(record),source:'native-store'}},
    async resolve(){const record=await read();return record?.kind==='api-key'&&valid(record.key)?record.key:undefined},
    async save(secret,expectedRevision){
      if(!valid(secret))throw new Error('PROCESSING_OPENROUTER_KEY_INVALID')
      if(typeof credentials?.modifyRecord!=='function')throw new Error('PROCESSING_CREDENTIAL_STORE_UNAVAILABLE')
      await credentials.modifyRecord(key,current=>{if(revision(current)!==expectedRevision)throw new Error('PROCESSING_CREDENTIAL_STALE');return{kind:'api-key',key:secret}})
      return this.status()
    },
  }
}
