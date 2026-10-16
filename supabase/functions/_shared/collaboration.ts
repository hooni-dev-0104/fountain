/** Stage-only port of fountain/collaboration.py. The parent CloudStore transaction
 * commits page/state/owners/version/audit together and handles CAS/receipt retries.
 * No browser state or hydration hint can become authoritative document contents.
 */
import {get,has,is_object,put_key,require,truth} from './access.ts';
import type {Access,Entity} from './access.ts';
import {Authorization} from './authorization.ts';
import * as crdt from './crdt.ts';
import type {CoreStore} from './core.ts';

export interface CollaborationWorkspace { validate_blocks(blocks:unknown):Entity[]; }
type Options={uid?:()=>string;clock?:()=>number};
export class Collaboration {
  store:CoreStore;
  workspace:CollaborationWorkspace;
  private uid:()=>string;
  private clock:()=>number;
  constructor(store:CoreStore,workspace:CollaborationWorkspace,options:Options={}){
    this.store=store;this.workspace=workspace;
    this.uid=options.uid??(()=>crypto.randomUUID().replaceAll('-',''));
    this.clock=options.clock??(()=>store.requestTime?Date.parse(store.requestTime)/1000:Date.now()/1000);
  }
  _document(page:Entity):Entity{
    let document=this.store.get('collaboration',page.id);
    if(document===null)document=this.store.put('collaboration',{id:page.id,epoch:this.uid(),seq:0,state:crdt.seed_state(get(page,'blocks',[])),op_owners:{}});
    return document;
  }
  _snapshot(page:Entity,document:Entity,access:Access):Entity{
    return {epoch:document.epoch,seq:document.seq,state:crdt.public_state(document.state),page,blocks:get(page,'blocks',[]),access_level:access.level('page',page),access_revision:this.store.meta('access_revision',0),workspace_id:this.store.meta('workspace_id')};
  }
  snapshot(page_id:unknown,access:Access):Entity{
    return this.store.transaction(()=>{
      const page=access.require_resource('page',page_id);
      return this._snapshot(page,this._document(page),access);
    });
  }
  apply(page_id:unknown,body:Entity,access:Access):Entity{
    return this.store.transaction(()=>{
      const page=access.require_resource('page',page_id,3);
      require(!truth(get(page,'locked')),'Page is locked',423);
      require(!truth(get(page,'archived')),'Restore the page before editing',409);
      const document=this._document(page);
      require(get(body,'epoch')===document.epoch,'Document was replaced. Keep your draft and reload before applying it.',409);
      const operations=get(body,'ops'),state=crdt.apply_operations(document.state,operations);
      const owners=Collaboration._operation_owners(document,operations,access.member_id);
      const ack=operations.map((operation:Entity)=>operation.id);
      if(crdt.canonical(state)!==crdt.canonical(document.state)){
        const blocks=this.workspace.validate_blocks(crdt.project(state)),authority=new Authorization(access);
        for(const block of blocks)if(truth(get(block,'attachment_id')))authority.attachment(block.attachment_id);
        const timestamp=this.clock();
        if(timestamp-get(document,'history_at',0)>=30){
          this.store.put('version',{page_id,revision:page.revision,title:page.title,blocks:get(page,'blocks',[])});
          document.history_at=timestamp;
        }
        page.blocks=blocks;page.revision++;
        const saved=this.store.put('page',page);
        document.state=state;document.op_owners=owners;document.seq++;
        const savedDocument=this.store.put('collaboration',document);
        this.store.audit('page.collaborated',{page_id,revision:saved.revision,operations:operations.length});
        return {...this._snapshot(saved,savedDocument,access),ack};
      }
      return {...this._snapshot(page,document,access),ack};
    });
  }
  static _operation_owners(document:Entity,operations:Entity[],member_id:string):Entity{
    const previous=document.state,owners={...get(document,'op_owners',{})},ledger=get(get(previous,'history',{}),'ops',{}),fresh=new Map<string,Entity>();
    for(const operation of operations)if(!has(previous.seen,operation.id))fresh.set(operation.id,operation);
    const clients=new Set(Array.from(fresh.values(),operation=>operation.client));
    for(const [identity,operation]of Object.entries(ledger) as Array<[string,Entity]>)if(clients.has(operation.client))require(get(owners,identity)===member_id,'Operation client belongs to another member or has no tracked owner',403);
    const prospective={...owners};for(const identity of fresh.keys())put_key(prospective,identity,member_id);
    for(const operation of fresh.values())if(operation.type==='history.cancel')for(const target of operation.targets){
      require(has(ledger,target)||fresh.has(target),'History target is not a tracked operation in this document',409);
      require(get(prospective,target)===member_id,'History target belongs to another member',403);
    }
    return prospective;
  }
}
