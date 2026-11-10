import { defineTool } from '@deepseek-ai/dsh-tools'
import { createNativeLinks } from './native.js'
export const name='airules-evidence-links-agent'
export const inject=['tools','agents','agentPresets','sandboxPolicy','approval','fs']
export function apply(ctx){
  const service=createNativeLinks(ctx)
  ctx.tools.register(defineTool({name:'airules_links',description:'Project evidence reference ledger: list/query code → note, document or source ID links, including stale source hashes. add/remove edit only .dsh/evidence-links.json via native sandbox/CAS after explicit approval; lead only. No URL fetching, graph extraction, document content or backend writes. Read first for expectedRevision.',
    parameters:{action:{type:'string',enum:['list','query','add','remove'],required:true},from:{type:'object',additionalProperties:true},to:{type:'object',additionalProperties:true},type:{type:'string',enum:['references','implements','verifiedBy','related']},provenance:{type:'object',additionalProperties:true},expectedRevision:{type:'string'},confirm:{type:'boolean'},linkId:{type:'string'},nodeId:{type:'string'},query:{type:'string'},limit:{type:'integer',description:'1..30 results; default 20'},cursor:{type:'string'}},
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:(args,exec)=>service.act(args,exec)}))
}
