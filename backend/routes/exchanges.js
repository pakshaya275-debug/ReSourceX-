/* ReSourceX exchange API. Mutations verify ownership and use database transactions. */
const express = require("express");
function initExchangesRouter({ pool, requireAuth, requireRole }) {
  const router = express.Router();
  const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
  const idOf = v => { const n=Number(v); return Number.isSafeInteger(n)&&n>0?n:null; };
  const positiveInt = v => { const n=Number(v); return Number.isSafeInteger(n)&&n>0?n:null; };
  const text = (v,max=1000) => String(v==null?"":v).trim().slice(0,max);
  const activeStatuses = ["PROPOSED","COUNTERED","ACCEPTED","IN_PROGRESS"];
  async function notify(userId,type,message,exchangeId) {
    try { await pool.query("INSERT INTO notifications (user_id,type,message,related_type,related_id) VALUES ($1,$2,$3,'exchange',$4)",[userId,type,message,exchangeId]); }
    catch(e) { console.error("ReSourceX notification failed:",e.message); }
  }
  async function participant(req,res,next) {
    const id=idOf(req.params.id);
    if(!id) return res.status(400).json({error:"Invalid exchange id"});
    try {
      const q=await pool.query("SELECT e.*,u.first_name AS initiator_first_name,u.last_name AS initiator_last_name,u1.first_name AS recipient_first_name,u1.last_name AS recipient_last_name FROM exchanges e JOIN users u ON u.id=e.initiator_id JOIN users u1 ON u1.id=e.recipient_id WHERE e.id=$1",[id]);
      if(!q.rows[0]) return res.status(404).json({error:"Exchange not found"});
      req.exchange=q.rows[0]; req.exchangeId=id;
      req.userIsInitiator=String(q.rows[0].initiator_id)===String(req.user.id);
      req.userIsRecipient=String(q.rows[0].recipient_id)===String(req.user.id);
      if(!req.userIsInitiator&&!req.userIsRecipient) return res.status(403).json({error:"Only exchange participants can access this exchange"});
      next();
    } catch(e) { next(e); }
  }
  async function lockResources(client,ids) {
    const sorted=[...new Set(ids.map(String))].map(Number).sort((a,b)=>a-b);
    const q=await client.query("SELECT id,donor_id,name,quantity,status FROM resources WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",[sorted]);
    return new Map(q.rows.map(r=>[String(r.id),r]));
  }
  async function exchangeView(id) {
    const q=await pool.query("SELECT e.*,ui.first_name AS initiator_first_name,ui.last_name AS initiator_last_name,ui.organisation_name AS initiator_organisation,ui.organisation_verified AS initiator_verified,ur.first_name AS recipient_first_name,ur.last_name AS recipient_last_name,ur.organisation_name AS recipient_organisation,ur.organisation_verified AS recipient_verified FROM exchanges e JOIN users ui ON ui.id=e.initiator_id JOIN users ur ON ur.id=e.recipient_id WHERE e.id=$1",[id]);
    if(!q.rows[0]) return null;
    const e=q.rows[0];
    const rr=await pool.query("SELECT er.side,er.quantity AS exchange_quantity,er.quantity_fulfilled,r.id AS resource_id,r.name,r.category,r.quantity AS stock_quantity,r.condition,r.location,r.availability,r.status AS resource_status,r.donor_id,r.latitude,r.longitude,u.location_privacy FROM exchange_resources er JOIN resources r ON r.id=er.resource_id JOIN users u ON u.id=r.donor_id WHERE er.exchange_id=$1 ORDER BY er.side",[id]);
    const share=["ACCEPTED","IN_PROGRESS","COMPLETED"].includes(e.status);
    const resources=rr.rows.map(r=>({id:r.resource_id,name:r.name,category:r.category,quantity:r.exchange_quantity,availableQuantity:r.stock_quantity,quantityFulfilled:r.quantity_fulfilled,condition:r.condition,availability:r.availability,status:r.resource_status,donorId:r.donor_id,location:share&&r.location_privacy==="exact"?r.location:null,coordinates:share&&r.location_privacy==="exact"&&r.latitude!=null&&r.longitude!=null?{latitude:r.latitude,longitude:r.longitude}:null,side:r.side}));
    const lm=await pool.query("SELECT m.id,m.sender_id,m.content,m.sent_at,u.first_name AS sender_first_name,u.last_name AS sender_last_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.exchange_id=$1 ORDER BY m.sent_at DESC LIMIT 1",[id]);
    return {id:e.id,initiator:{id:e.initiator_id,firstName:e.initiator_first_name,lastName:e.initiator_last_name,organisationName:e.initiator_organisation,organisationVerified:Boolean(e.initiator_verified)},recipient:{id:e.recipient_id,firstName:e.recipient_first_name,lastName:e.recipient_last_name,organisationName:e.recipient_organisation,organisationVerified:Boolean(e.recipient_verified)},currentProposerId:e.current_proposer_id,status:e.status,message:e.message,proposedAt:e.proposed_at,respondedAt:e.responded_at,acceptedAt:e.accepted_at,completedAt:e.completed_at,cancelledAt:e.cancelled_at,initiatorHandoverConfirmed:Boolean(e.initiator_handover_at),recipientHandoverConfirmed:Boolean(e.recipient_handover_at),initiatorReceiptConfirmed:Boolean(e.initiator_completed_at),recipientReceiptConfirmed:Boolean(e.recipient_completed_at),offeredResources:resources.filter(r=>r.side==="offered").map(({side,...r})=>r),requestedResources:resources.filter(r=>r.side==="requested").map(({side,...r})=>r),lastMessage:lm.rows[0]||null};
  }
  router.get("/",requireAuth,requireRole("DONOR","RECIPIENT","ADMIN"),asyncRoute(async(req,res)=>{
    const where=[],values=[];
    if(req.user.role!=="ADMIN"){values.push(req.user.id);where.push("(e.initiator_id=$1 OR e.recipient_id=$1)");}
    if(req.query.status){const s=text(req.query.status,30).toUpperCase();if(!["PROPOSED","COUNTERED","ACCEPTED","IN_PROGRESS","COMPLETED","DECLINED","CANCELLED"].includes(s))return res.status(400).json({error:"Invalid status filter"});values.push(s);where.push("e.status=$"+values.length);}
    const filter=where.length?" WHERE "+where.join(" AND "):"";
    const count=await pool.query("SELECT COUNT(*)::int AS count FROM exchanges e"+filter,values);
    const limit=Math.min(positiveInt(req.query.limit)||50,100),n=Number(req.query.offset),offset=Number.isSafeInteger(n)&&n>=0?n:0,page=[...values,limit,offset];
    const ids=await pool.query("SELECT e.id FROM exchanges e"+filter+" ORDER BY e.proposed_at DESC LIMIT $"+(page.length-1)+" OFFSET $"+page.length,page);
    const exchanges=[];for(const row of ids.rows) exchanges.push(await exchangeView(row.id));
    return res.json({exchanges,count:count.rows[0].count,limit,offset});
  }));
  router.get("/:id",requireAuth,requireRole("DONOR","RECIPIENT","ADMIN"),participant,asyncRoute(async(req,res)=>res.json({exchange:await exchangeView(req.exchangeId)})));
  router.post("/",requireAuth,requireRole("DONOR","RECIPIENT"),asyncRoute(async(req,res)=>{
    const recipient=idOf(req.body.recipient_id??req.body.recipientId),offeredId=idOf(req.body.offered_resource_id??req.body.offeredResourceId),requestedId=idOf(req.body.requested_resource_id??req.body.requestedResourceId),offeredQty=positiveInt(req.body.offered_quantity??req.body.offeredQuantity),requestedQty=positiveInt(req.body.requested_quantity??req.body.requestedQuantity),message=text(req.body.message);
    if(!recipient||!offeredId||!requestedId||!offeredQty||!requestedQty)return res.status(400).json({error:"Recipient, two different resource IDs, and positive quantities are required"});
    if(String(req.user.id)===String(recipient)||offeredId===requestedId)return res.status(400).json({error:"An exchange must involve another user and two different resources"});
    const c=await pool.connect();let done=false;
    try{
      await c.query("BEGIN");const locked=await lockResources(c,[offeredId,requestedId]),offered=locked.get(String(offeredId)),requested=locked.get(String(requestedId));
      if(!offered||!requested){await c.query("ROLLBACK");done=true;return res.status(404).json({error:"One or both resources were not found"});}
      if(String(offered.donor_id)!==String(req.user.id)){await c.query("ROLLBACK");done=true;return res.status(403).json({error:"You can only offer a resource you own"});}
      if(String(requested.donor_id)!==String(recipient)){await c.query("ROLLBACK");done=true;return res.status(400).json({error:"The requested resource must belong to the selected recipient"});}
      if(offered.status!=="AVAILABLE"||requested.status!=="AVAILABLE"){await c.query("ROLLBACK");done=true;return res.status(409).json({error:"Both resources must currently be available"});}
      if(offeredQty>offered.quantity||requestedQty>requested.quantity){await c.query("ROLLBACK");done=true;return res.status(422).json({error:"An exchange quantity exceeds the resource quantity"});}
      const active=await c.query("SELECT 1 FROM exchange_resources er JOIN exchanges e ON e.id=er.exchange_id WHERE er.resource_id=ANY($1::bigint[]) AND e.status=ANY($2::text[]) LIMIT 1",[[offeredId,requestedId],activeStatuses]);
      if(active.rowCount){await c.query("ROLLBACK");done=true;return res.status(409).json({error:"One or both resources already belong to an active exchange"});}
      const created=await c.query("INSERT INTO exchanges (initiator_id,recipient_id,current_proposer_id,message) VALUES ($1,$2,$1,$3) RETURNING id",[req.user.id,recipient,message]),id=created.rows[0].id;
      await c.query("INSERT INTO exchange_resources (exchange_id,side,resource_id,quantity) VALUES ($1,'offered',$2,$3),($1,'requested',$4,$5)",[id,offeredId,offeredQty,requestedId,requestedQty]);
      await c.query("COMMIT");done=true;await notify(recipient,"new_exchange_offer","You have received a new resource exchange proposal.",id);
      return res.status(201).json({exchange:await exchangeView(id)});
    }catch(e){if(!done)await c.query("ROLLBACK");throw e;}finally{c.release();}
  }));
  router.put("/:id/respond",requireAuth,requireRole("DONOR","RECIPIENT","ADMIN"),participant,asyncRoute(async(req,res)=>{
    const action=text(req.body.action,30).toLowerCase(),message=text(req.body.message);
    if(!["accept","decline","counteroffer"].includes(action))return res.status(400).json({error:"Action must be accept, decline, or counteroffer"});
    const c=await pool.connect();let done=false,notice;
    try{
      await c.query("BEGIN");const q=await c.query("SELECT * FROM exchanges WHERE id=$1 FOR UPDATE",[req.exchangeId]),e=q.rows[0];
      if(!e){await c.query("ROLLBACK");done=true;return res.status(404).json({error:"Exchange not found"});}
      if(String(e.current_proposer_id)===String(req.user.id)){await c.query("ROLLBACK");done=true;return res.status(403).json({error:"Only the other participant can respond to the current proposal"});}
      if(!["PROPOSED","COUNTERED"].includes(e.status)){await c.query("ROLLBACK");done=true;return res.status(409).json({error:"This exchange is no longer awaiting a response"});}
      const old=await c.query("SELECT resource_id FROM exchange_resources WHERE exchange_id=$1",[req.exchangeId]),oldIds=old.rows.map(r=>Number(r.resource_id)),other=String(e.initiator_id)===String(req.user.id)?e.recipient_id:e.initiator_id;
      if(action==="counteroffer"){
        const offeredId=idOf(req.body.offered_resource_id??req.body.offeredResourceId),requestedId=idOf(req.body.requested_resource_id??req.body.requestedResourceId),offeredQty=positiveInt(req.body.offered_quantity??req.body.offeredQuantity),requestedQty=positiveInt(req.body.requested_quantity??req.body.requestedQuantity);
        if(!offeredId||!requestedId||offeredId===requestedId||!offeredQty||!requestedQty){await c.query("ROLLBACK");done=true;return res.status(400).json({error:"Counteroffer requires two different resource IDs and positive quantities"});}
        const locked=await lockResources(c,[...oldIds,offeredId,requestedId]),a=locked.get(String(offeredId)),b=locked.get(String(requestedId));
        if(!a||!b||String(a.donor_id)!==String(req.user.id)||String(b.donor_id)!==String(other)){await c.query("ROLLBACK");done=true;return res.status(403).json({error:"Counteroffer resources must belong to you and the other participant respectively"});}
        if(a.status!=="AVAILABLE"||b.status!=="AVAILABLE"||offeredQty>a.quantity||requestedQty>b.quantity){await c.query("ROLLBACK");done=true;return res.status(409).json({error:"Counteroffer resources must be available and quantities must fit"});}
        const active=await c.query("SELECT 1 FROM exchange_resources er JOIN exchanges e ON e.id=er.exchange_id WHERE er.resource_id=ANY($1::bigint[]) AND e.id<>$2 AND e.status=ANY($3::text[]) LIMIT 1",[[offeredId,requestedId],req.exchangeId,activeStatuses]);
        if(active.rowCount){await c.query("ROLLBACK");done=true;return res.status(409).json({error:"A counteroffer resource is already involved in another active exchange"});}
        await c.query("UPDATE exchange_resources SET resource_id=$2,quantity=$3,quantity_fulfilled=0 WHERE exchange_id=$1 AND side='offered'",[req.exchangeId,offeredId,offeredQty]);
        await c.query("UPDATE exchange_resources SET resource_id=$2,quantity=$3,quantity_fulfilled=0 WHERE exchange_id=$1 AND side='requested'",[req.exchangeId,requestedId,requestedQty]);
        await c.query("UPDATE exchanges SET status='COUNTERED',current_proposer_id=$2,message=$3,responded_at=NOW() WHERE id=$1",[req.exchangeId,req.user.id,message]);
        notice={userId:other,type:"exchange_counteroffer",message:"A participant has sent a counteroffer."};
      }else if(action==="decline"){
        await c.query("UPDATE exchanges SET status='DECLINED',message=CASE WHEN $2='' THEN message ELSE $2 END,responded_at=NOW() WHERE id=$1",[req.exchangeId,message]);
        notice={userId:other,type:"exchange_declined",message:"Your exchange proposal was declined."};
      }else{
        const locked=await lockResources(c,oldIds),rs=oldIds.map(id=>locked.get(String(id)));
        if(rs.some(r=>!r||r.status!=="AVAILABLE")){await c.query("ROLLBACK");done=true;return res.status(409).json({error:"One or both resources are no longer available"});}
        const pairs=await c.query("SELECT resource_id,quantity FROM exchange_resources WHERE exchange_id=$1",[req.exchangeId]);
        if(pairs.rows.some(p=>Number(p.quantity)>Number(locked.get(String(p.resource_id)).quantity))){await c.query("ROLLBACK");done=true;return res.status(409).json({error:"Resource quantity changed; submit a new proposal"});}
        await c.query("UPDATE resources SET status='ALLOCATED',updated_at=NOW() WHERE id=ANY($1::bigint[])",[oldIds]);
        await c.query("UPDATE exchanges SET status='ACCEPTED',accepted_at=NOW(),responded_at=NOW(),message=CASE WHEN $2='' THEN message ELSE $2 END WHERE id=$1",[req.exchangeId,message]);
        notice={userId:other,type:"exchange_accepted",message:"Your exchange proposal was accepted."};
      }
      await c.query("COMMIT");done=true;if(notice)await notify(notice.userId,notice.type,notice.message,req.exchangeId);
      return res.json({exchange:await exchangeView(req.exchangeId)});
    }catch(e){if(!done)await c.query("ROLLBACK");throw e;}finally{c.release();}
  }));
  router.put("/:id/cancel",requireAuth,requireRole("DONOR","RECIPIENT","ADMIN"),participant,asyncRoute(async(req,res)=>{
    const c=await pool.connect();let done=false;
    try{
      await c.query("BEGIN");const q=await c.query("SELECT * FROM exchanges WHERE id=$1 FOR UPDATE",[req.exchangeId]),e=q.rows[0];
      if(!e){await c.query("ROLLBACK");done=true;return res.status(404).json({error:"Exchange not found"});}
      if(String(e.current_proposer_id)!==String(req.user.id)){await c.query("ROLLBACK");done=true;return res.status(403).json({error:"Only the current proposer can cancel the proposal"});}
      if(!["PROPOSED","COUNTERED"].includes(e.status)){await c.query("ROLLBACK");done=true;return res.status(409).json({error:"An accepted exchange cannot be cancelled through this endpoint"});}
      await c.query("UPDATE exchanges SET status='CANCELLED',cancelled_at=NOW() WHERE id=$1",[req.exchangeId]);await c.query("COMMIT");done=true;
      const other=String(e.initiator_id)===String(req.user.id)?e.recipient_id:e.initiator_id;await notify(other,"exchange_cancelled","An exchange proposal was cancelled.",req.exchangeId);
      return res.json({exchange:await exchangeView(req.exchangeId)});
    }catch(e){if(!done)await c.query("ROLLBACK");throw e;}finally{c.release();}
  }));
  router.put("/:id/progress",requireAuth,requireRole("DONOR","RECIPIENT","ADMIN"),participant,asyncRoute(async(req,res)=>{
    const c=await pool.connect();let done=false;
    try{
      await c.query("BEGIN");const q=await c.query("SELECT * FROM exchanges WHERE id=$1 FOR UPDATE",[req.exchangeId]),e=q.rows[0];
      if(!e){await c.query("ROLLBACK");done=true;return res.status(404).json({error:"Exchange not found"});}
      if(!["ACCEPTED","IN_PROGRESS"].includes(e.status)){await c.query("ROLLBACK");done=true;return res.status(409).json({error:"Only an accepted exchange can record handover confirmation"});}
      const col=String(e.initiator_id)===String(req.user.id)?"initiator_handover_at":"recipient_handover_at";
      await c.query("UPDATE exchanges SET "+col+"=COALESCE("+col+",NOW()) WHERE id=$1",[req.exchangeId]);
      const state=await c.query("SELECT initiator_handover_at,recipient_handover_at FROM exchanges WHERE id=$1",[req.exchangeId]);
      if(state.rows[0].initiator_handover_at&&state.rows[0].recipient_handover_at){
        const ids=await c.query("SELECT resource_id FROM exchange_resources WHERE exchange_id=$1",[req.exchangeId]);
        const changed=await c.query("UPDATE resources SET status='HANDED_OVER',updated_at=NOW() WHERE id=ANY($1::bigint[]) AND status='ALLOCATED'",[ids.rows.map(r=>r.resource_id)]);
        if(changed.rowCount!==2)throw new Error("Exchange resource states changed unexpectedly during handover");
        await c.query("UPDATE exchanges SET status='IN_PROGRESS' WHERE id=$1",[req.exchangeId]);
      }
      await c.query("COMMIT");done=true;const other=String(e.initiator_id)===String(req.user.id)?e.recipient_id:e.initiator_id;
      await notify(other,"exchange_handover_confirmation","A participant confirmed their side of the exchange handover.",req.exchangeId);
      return res.json({exchange:await exchangeView(req.exchangeId)});
    }catch(e){if(!done)await c.query("ROLLBACK");throw e;}finally{c.release();}
  }));
  router.put("/:id/complete",requireAuth,requireRole("DONOR","RECIPIENT","ADMIN"),participant,asyncRoute(async(req,res)=>{
    const c=await pool.connect();let done=false;
    try{
      await c.query("BEGIN");const q=await c.query("SELECT * FROM exchanges WHERE id=$1 FOR UPDATE",[req.exchangeId]),e=q.rows[0];
      if(!e){await c.query("ROLLBACK");done=true;return res.status(404).json({error:"Exchange not found"});}
      if(e.status!=="IN_PROGRESS"){await c.query("ROLLBACK");done=true;return res.status(409).json({error:"Both parties must confirm handover before receipt can be confirmed"});}
      const col=String(e.initiator_id)===String(req.user.id)?"initiator_completed_at":"recipient_completed_at";
      await c.query("UPDATE exchanges SET "+col+"=COALESCE("+col+",NOW()) WHERE id=$1",[req.exchangeId]);
      const state=await c.query("SELECT initiator_completed_at,recipient_completed_at FROM exchanges WHERE id=$1",[req.exchangeId]);
      if(state.rows[0].initiator_completed_at&&state.rows[0].recipient_completed_at){
        const items=await c.query("SELECT resource_id,quantity FROM exchange_resources WHERE exchange_id=$1",[req.exchangeId]);
        if(items.rowCount!==2)throw new Error("Exchange must contain exactly two resource sides");
        for(const item of items.rows){
          const changed=await c.query(
            "UPDATE resources SET quantity=CASE WHEN quantity > $2 THEN quantity-$2 ELSE quantity END, " +
            "status=CASE WHEN quantity > $2 THEN 'AVAILABLE' ELSE 'COMPLETED' END, updated_at=NOW() " +
            "WHERE id=$1 AND status='HANDED_OVER' AND quantity >= $2",
            [item.resource_id,item.quantity]
          );
          if(changed.rowCount!==1)throw new Error("Exchange resource quantity or state changed unexpectedly during completion");
        }
        await c.query("UPDATE exchange_resources SET quantity_fulfilled=quantity WHERE exchange_id=$1",[req.exchangeId]);
        await c.query("UPDATE exchanges SET status='COMPLETED',completed_at=NOW() WHERE id=$1",[req.exchangeId]);
      }
      await c.query("COMMIT");done=true;const other=String(e.initiator_id)===String(req.user.id)?e.recipient_id:e.initiator_id;
      await notify(other,"exchange_receipt_confirmation","A participant confirmed receipt of their exchange resources.",req.exchangeId);
      return res.json({exchange:await exchangeView(req.exchangeId)});
    }catch(e){if(!done)await c.query("ROLLBACK");throw e;}finally{c.release();}
  }));
  router.get("/:id/messages",requireAuth,requireRole("DONOR","RECIPIENT","ADMIN"),participant,asyncRoute(async(req,res)=>{
    const limit=Math.min(positiveInt(req.query.limit)||50,100),n=Number(req.query.offset),offset=Number.isSafeInteger(n)&&n>=0?n:0;
    const q=await pool.query("SELECT m.id,m.sender_id,m.content,m.sent_at,u.first_name AS sender_first_name,u.last_name AS sender_last_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.exchange_id=$1 ORDER BY m.sent_at DESC LIMIT $2 OFFSET $3",[req.exchangeId,limit,offset]);
    return res.json({messages:q.rows,limit,offset});
  }));
  router.post("/:id/messages",requireAuth,requireRole("DONOR","RECIPIENT","ADMIN"),participant,asyncRoute(async(req,res)=>{
    const content=text(req.body.content,2000);if(!content)return res.status(400).json({error:"Message content is required"});
    const q=await pool.query("INSERT INTO messages (exchange_id,sender_id,content) VALUES ($1,$2,$3) RETURNING id,sender_id,content,sent_at",[req.exchangeId,req.user.id,content]);
    const other=req.userIsInitiator?req.exchange.recipient_id:req.exchange.initiator_id;await notify(other,"new_message","A participant sent a message in your exchange.",req.exchangeId);
    return res.status(201).json({message:q.rows[0]});
  }));
  return router;
}
module.exports={initExchangesRouter};
