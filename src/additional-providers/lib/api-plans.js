import { createHmac, randomBytes } from 'node:crypto'

export const PLAN_SUBSCRIPTIONS = Object.freeze([
  Object.freeze({ id:'airules-zai-plan', nativeId:'zai', credentialId:'zai-plan', name:'GLM · Coding Plan' }),
  Object.freeze({ id:'airules-qwen-plan', nativeId:'qwen-token-plan', credentialId:'qwen-plan', name:'Qwen Token Plan · International' }),
  Object.freeze({ id:'airules-opencode-go', nativeId:'opencode-go', credentialId:'opencode-go', name:'OpenCode Go' }),
])

export function aliasPlanProvider(native, spec) {
  if (!native || native.id !== spec.nativeId || typeof native.getModels !== 'function') return undefined
  const alias = model => ({ ...model, provider:spec.id })
  return { ...native, id:spec.id, name:spec.name,
    getModels:(...args)=>native.getModels(...args).map(alias),
    getAllModels:(...args)=>(native.getAllModels?.(...args)??native.getModels(...args)).map(alias),
  }
}

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const configured = record => record?.kind === 'api-key' && typeof record.key === 'string' && !!record.key.trim()
const keyValid = value => typeof value === 'string' && value.length >= 8 && value.length <= 4096 && value === value.trim() && !/[\0\r\n\t]/u.test(value)

export function createApiPlanController({credentials, keyFor, providers, changed=()=>{}}) {
  const salt=randomBytes(32), byId=new Map(PLAN_SUBSCRIPTIONS.map(row=>[row.id,row]))
  const revision = record => createHmac('sha256',salt).update(JSON.stringify(record??null)).digest('hex')
  let queue=Promise.resolve(), closed=false
  const serial = operation => {const result=queue.then(operation);queue=result.catch(()=>{});return result}
  const specOf = id => {const spec=byId.get(id);if(!spec)throw new Error('PLAN_PROVIDER_REJECTED');return spec}
  const recordOf = spec => credentials.readRecord(keyFor(spec.credentialId))
  async function snapshot() {
    return {providers:await Promise.all(PLAN_SUBSCRIPTIONS.map(async spec=>{
      const record=await recordOf(spec), provider=providers.get(spec.id)
      return {id:spec.id,name:spec.name,nativeId:spec.nativeId,available:!!provider,connected:configured(record),revision:revision(record),
        modelCount:provider?.getModels().length??0,accounts:1,quotaAvailable:false}
    }))}
  }
  const store={
    async read(id) {const spec=byId.get(id);if(!spec)return undefined;const record=await recordOf(spec);return configured(record)?{type:'api_key',key:record.key}:undefined},
    async list() {return (await snapshot()).providers.filter(row=>row.connected).map(row=>({providerId:row.id,type:'api_key'}))},
    async modify(){throw new Error('PLAN_CREDENTIAL_READ_ONLY')},
    async delete(){throw new Error('PLAN_CREDENTIAL_READ_ONLY')},
  }
  return {snapshot,store,
    async resolveApiKey(id) {const spec=specOf(id);if(!providers.has(id))throw new Error('PLAN_PROVIDER_UNAVAILABLE');const record=await recordOf(spec);return configured(record)?record.key:undefined},
    action(input) {return serial(async()=>{
      if(closed)throw new Error('PLAN_CONTROLLER_CLOSED')
      if(!object(input)||Object.keys(input).some(key=>!['action','provider','revision','key'].includes(key)))throw new Error('PLAN_FIELDS_REJECTED')
      const spec=specOf(input.provider)
      if(!['save','logout'].includes(input.action)||typeof input.revision!=='string'||!/^[a-f0-9]{64}$/u.test(input.revision))throw new Error('PLAN_ACTION_REJECTED')
      if(input.action==='save') {
        if(!providers.has(spec.id))throw new Error('PLAN_PROVIDER_UNAVAILABLE')
        if(!keyValid(input.key))throw new Error('PLAN_KEY_INVALID')
        await credentials.modifyRecord(keyFor(spec.credentialId),current=>{
          if(revision(current)!==input.revision)throw new Error('PLAN_STALE')
          if(closed)throw new Error('PLAN_CONTROLLER_CLOSED')
          return {kind:'api-key',key:input.key}
        })
      } else {
        if(input.key!==undefined)throw new Error('PLAN_FIELDS_REJECTED')
        if(revision(await recordOf(spec))!==input.revision)throw new Error('PLAN_STALE')
        await credentials.deleteRecord(keyFor(spec.credentialId))
      }
      changed();return snapshot()
    })},
    close(){closed=true},
  }
}
