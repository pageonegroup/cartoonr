import express from "express";
import cors from "cors";
import OpenAI, { toFile } from "openai";
import crypto from "crypto";

const app=express();
const port=process.env.PORT||3000;
app.use(cors());
app.use(express.json({limit:"80mb"}));
const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
const jobs=new Map();

const CARTOONR_BUBBLE_STYLE={
  reference_match:"Use the supplied kawaii comic reference as the visual target for speech bubbles and lettering.",
  bubble:{
    family:"hand-drawn rounded rectangular comic panel bubble",
    fill:"#FFFDF7",
    outline_color:"#173746",
    outline_weight:"thick, approximately 5-7 px at 1080x1080 equivalent",
    outline_quality:"single dark navy hand-inked contour with subtle natural wobble",
    corners:"large soft rounded corners; NOT a cloud, oval, thought bubble, scalloped bubble, or balloon",
    shape:"mostly rectangular with gently bowed imperfect sides",
    tail:"one short integrated downward triangular/curved tail, same fill and outline, pointing toward speaker",
    padding:"generous and visually even; text never touches outline",
    effects:"no shadow, no gradient, no double border, no 3D"
  },
  lettering:{
    appearance:"bold hand-lettered uppercase comic print matching the reference",
    color:"#173746",
    case:"UPPERCASE",
    stroke:"thick rounded marker/ink strokes",
    width:"slightly condensed to medium",
    baseline:"subtly irregular and human, never typeset-perfect",
    spacing:"compact but readable",
    line_height:"tight but not touching",
    alignment:"centered within bubble",
    weight:"heavy",
    forbidden:"serif, italic, script, thin sans, geometric typesetting, polished digital font"
  },
  layout:{
    bubble_size:"fit the dialogue tightly with generous padding; do not make it unnecessarily huge",
    line_breaks:"short balanced centered lines similar to the reference",
    tail_clearance:"tail must remain clearly visible and must not collide with character",
    canvas_clearance:"entire bubble and tail stay safely inside canvas"
  }
};

const dirs={
  1:`DIVERSITY PLAN A — WIDE / FULL BODY
- Show the complete character from head to feet with generous white space.
- Character placement: left third or center-left.
- Body orientation: frontal or slight three-quarter turn.
- Required action must remain clearly visible.
- Free hand must use a natural secondary gesture that is NOT hand-on-hip and NOT pointing.
- Speech bubble placement: upper-right or above character.
- Do not use the composition assigned to Options 2 or 3.`,

  2:`DIVERSITY PLAN B — MEDIUM / THREE-QUARTER
- Frame approximately knees or mid-thigh upward; do NOT show the same full-body framing as Option 1.
- Character placement: center or center-right.
- Body orientation: visibly different from Option 1, preferably opposite three-quarter angle.
- Required action must remain clearly visible.
- Free hand must perform an open-palm, chest-level, or relaxed secondary gesture; do NOT copy Option 1.
- Speech bubble placement: upper-left or opposite the character.
- Do not use the composition assigned to Options 1 or 3.`,

  3:`DIVERSITY PLAN C — CLOSE / WAIST-UP
- Frame waist/chest upward; character should appear substantially larger than Options 1 and 2.
- Character placement: right third or a deliberately different position from the other options.
- Use a distinct head angle and body lean.
- Required action must remain clearly visible even in the close crop.
- Free hand gesture must differ from Options 1 and 2.
- Speech bubble placement must differ from the other options while remaining safely inside the canvas.
- Do not use full-body framing and do not imitate Option 1 or Option 2.`
};


const POSE_BANK=[
 {id:"front-wide",crop:"full body",placement:"left third",orientation:"front-facing",head:"slight tilt right",freeHand:"open palm away from torso",bubble:"upper right"},
 {id:"three-quarter-left",crop:"three-quarter body",placement:"right third",orientation:"three-quarter facing camera-left",head:"turned slightly toward viewer",freeHand:"hand near chest",bubble:"upper left"},
 {id:"profile-left",crop:"medium body",placement:"center-right",orientation:"clear left-facing profile or near-profile",head:"looking toward camera-left",freeHand:"relaxed downward or interacting with required prop",bubble:"upper left"},
 {id:"profile-right",crop:"medium body",placement:"center-left",orientation:"clear right-facing profile or near-profile",head:"looking toward camera-right",freeHand:"relaxed outward gesture",bubble:"upper right"},
 {id:"close-lean",crop:"waist-up close",placement:"right third",orientation:"three-quarter facing camera-right",head:"slight downward/upward tilt",freeHand:"distinct expressive gesture",bubble:"upper left"},
 {id:"wide-turn",crop:"full body",placement:"center",orientation:"body turned partly away, face looking back toward viewer",head:"over-shoulder turn",freeHand:"relaxed natural position",bubble:"upper opposite side"},
 {id:"low-seated",crop:"full body including furniture if required",placement:"left or center-left",orientation:"three-quarter facing camera-right",head:"toward viewer",freeHand:"resting or interacting with required prop",bubble:"upper right"},
 {id:"dynamic-step",crop:"full body",placement:"right or center-right",orientation:"walking/stepping three-quarter facing camera-left",head:"toward destination or viewer",freeHand:"counterbalanced natural motion",bubble:"upper left"},
 {id:"close-front",crop:"chest-up",placement:"center-left",orientation:"front-facing",head:"distinct tilt",freeHand:"visible only if compatible with crop",bubble:"upper right"}
];
function hashSeed(s){
 let h=2166136261;
 for(const ch of String(s)){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}
 return h>>>0;
}
function diversityPlans(job){
 const count=job.optionCount||3;
 const seed=hashSeed(`${job.id}|${job.stripName}|${job.createdAt}`);
 const pool=[...POSE_BANK];
 // deterministic shuffle gives each new job a different plan without changing while polling/retrying
 for(let i=pool.length-1;i>0;i--){
   const mixed=(seed + Math.imul(i,2654435761))>>>0;
   const j=mixed%(i+1);
   if(pool[j]!==undefined)[pool[i],pool[j]]=[pool[j],pool[i]];
 }
 const chosen=[];
 for(const p of pool){
   if(chosen.length>=count)break;
   if(!p)continue;
   const orientations=chosen.filter(Boolean).map(x=>x.orientation||"");
   const crops=chosen.filter(Boolean).map(x=>x.crop||"");
   // prefer genuinely different facing directions and crops
   if(orientations.includes(p.orientation))continue;
   if(chosen.length<2 && crops.includes(p.crop))continue;
   chosen.push(p);
 }
 for(const p of pool){if(chosen.length>=count)break;if(p&&!chosen.includes(p))chosen.push(p);}
 while(chosen.length<count)chosen.push(POSE_BANK[chosen.length%POSE_BANK.length]);
 return chosen;
}

app.get("/",(_q,res)=>res.json({ok:true,service:"cartoonr-backend",version:"2.3-diversity",model:"gpt-image-2",backgroundJobs:true}));
app.get("/health",(_q,res)=>res.json({ok:true,version:"2.3-diversity",openaiConfigured:Boolean(process.env.OPENAI_API_KEY),jobs:jobs.size}));

function parseDataUrl(dataUrl,index){
 const m=/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/s.exec(dataUrl||"");
 if(!m)throw new Error(`Reference ${index+1} is not a supported image.`);
 const mime=m[1]==="image/jpg"?"image/jpeg":m[1];
 const ext=mime==="image/png"?"png":mime==="image/webp"?"webp":"jpg";
 return {mime,ext,buffer:Buffer.from(m[2],"base64")};
}
async function prepareImages(refs){
 const out=[];
 for(let i=0;i<refs.length;i++){
   const p=parseDataUrl(refs[i],i);
   out.push(await toFile(p.buffer,`reference-${i+1}.${p.ext}`,{type:p.mime}));
 }
 return out;
}

function promptFor({characterName,line,option,optionCount=3,plan=null}){
 const dialogue=String(line?.text||"").trim();
 const pose=String(line?.pose||"").trim();
 const direction=String(line?.direction||"").trim();
 const emotion=String(line?.emotion||"").trim();
 return `Create ONE finished square cartoon artcard for "${characterName||"the supplied character"}".

REFERENCE LOCK
The uploaded images are the sole visual basis. Preserve the same recognizable character, face construction, age cues, hairstyle, proportions, clothing conventions, stroke/outline character, palette, coloring method, illustration finish, and personality. Do not redesign the character.

USER DIRECTIONS — HIGHEST PRIORITY
POSE / ACTION: ${pose ? `REQUIRED — ${pose}` : "SYSTEM DECIDES from the dialogue."}
ADDITIONAL DIRECTION: ${direction ? `REQUIRED — ${direction}` : "SYSTEM DECIDES; avoid unnecessary props."}
EMOTION: ${emotion ? `REQUIRED — ${emotion}` : "SYSTEM DECIDES from the dialogue."}

Every non-empty user direction is mandatory and must be visibly depicted. It is NOT a suggestion. If Pose / Action says "standing", the character must visibly be standing. If Additional Direction says "drinking coffee", show a coffee cup and the character actively drinking/sipping coffee. Do not replace requested actions with pointing, shrugging, waving, raised-index-finger advice gestures, or hands-on-hips poses.

DIALOGUE — EXACT TEXT
The speech bubble must contain ONLY this exact dialogue:
"${dialogue}"
Never put metadata, JSON, placeholders, "[object Object]", character names, Pose / Action, Additional Direction, or Emotion inside the speech bubble. Preserve the dialogue verbatim.

SPEECH BUBBLE — VISUAL MATCH IS MANDATORY
Reproduce the speech-bubble construction and lettering character described below as closely as possible:
${JSON.stringify(CARTOONR_BUBBLE_STYLE)}
CRITICAL: the bubble must look like the supplied reference: a hand-drawn ROUNDED RECTANGLE with thick dark navy outline and a short integrated tail. It must NOT become a cloud-shaped speech bubble, oval balloon, scalloped bubble, thought bubble, or generic comic bubble. Lettering must be bold uppercase hand-drawn navy marker lettering, centered with short balanced lines. Preserve every dialogue word exactly.

BACKGROUND
Pure solid white (#FFFFFF), no colored wash, gradient, texture, scenery, room, or vignette.

OPTION ${option} OF ${optionCount}
${optionCount>1 ? `ASSIGNED RANDOM COMPOSITION — FOLLOW THIS:
Crop: ${plan?.crop||"natural"}
Character placement: ${plan?.placement||"natural"}
Body orientation: ${plan?.orientation||"natural"}
Head direction: ${plan?.head||"natural"}
Free-hand behavior: ${plan?.freeHand||"natural"}
Speech-bubble placement: ${plan?.bubble||"natural"}` : "SINGLE-OPTION MODE — choose the strongest composition for the user's directions."}
The assigned composition is mandatory unless it conflicts with an explicit user Pose / Action or Additional Direction. User directions always win.
Variation may change framing, placement, camera distance, and secondary body language, but MUST preserve every user-required action, prop, and emotion.

OPTION DIVERSITY — HARD RULE
The selected DIVERSITY PLAN above is mandatory whenever more than one option is requested. Options are alternatives, not near-duplicates. Preserve the same character identity, exact dialogue, required pose/action, required prop/action, emotion, white background, and bubble style, but vary ALL practical composition dimensions: camera distance, crop, body orientation, character placement, head angle, free-hand gesture, prop position when possible, and speech-bubble placement. Never create two options with substantially the same silhouette and framing. Do not default to pointing, raised index finger, shrugging, or hands on hips unless explicitly required by the user.

SAFE COMPOSITION
Keep character, hair, hands, clothing, props, furniture, speech bubble and tail fully inside the canvas with generous white margins. Nothing may touch or be cut by the left or right edge.

OUTPUT
One square artcard only. No collage, signature, watermark, character name, extra caption, or extra text.`;
}

async function generateOne(job,lineIndex,option){
 const line=job.lines[lineIndex], rec=line.options[option-1];
 rec.status="generating";rec.startedAt=Date.now();rec.error=null;job.updatedAt=Date.now();
 try{
   const images=await prepareImages(job.characterReferences);
   const r=await client.images.edit({model:"gpt-image-2",image:images,prompt:promptFor({characterName:job.characterName,line,option,optionCount:job.optionCount,plan:job.diversityPlans?.[option-1]||POSE_BANK[(option-1)%POSE_BANK.length]}),size:"1024x1024",quality:"high",output_format:"png",n:1});
   const b64=r?.data?.[0]?.b64_json;
   if(!b64)throw new Error("OpenAI returned no image data.");
   rec.imageData=`data:image/png;base64,${b64}`;rec.status="complete";rec.completedAt=Date.now();
 }catch(e){rec.status="failed";rec.error=e?.message||"Generation failed";rec.completedAt=Date.now();}
 job.updatedAt=Date.now();
}
async function runJob(job){
 job.status="running";job.startedAt=Date.now();job.updatedAt=Date.now();
 for(let i=0;i<job.lines.length;i++){
   await Promise.all(Array.from({length:job.optionCount},(_,k)=>k+1).map(n=>generateOne(job,i,n)));
 }
 const all=job.lines.flatMap(l=>l.options);
 job.status=all.every(x=>x.status==="complete")?"complete":all.some(x=>x.status==="complete")?"complete_with_errors":"failed";
 job.completedAt=Date.now();job.updatedAt=Date.now();
}

app.post("/jobs",(req,res)=>{
 try{
  if(!process.env.OPENAI_API_KEY)return res.status(500).json({error:"OPENAI_API_KEY is not configured."});
  const {stripId,stripName="",characterName="",characterReferences=[],lines=[],optionCount=3}=req.body||{};
  const count=Math.max(1,Math.min(3,Number(optionCount)||3));
  if(!Array.isArray(characterReferences)||!characterReferences.length)return res.status(400).json({error:"Character references are required."});
  if(!Array.isArray(lines)||!lines.length)return res.status(400).json({error:"At least one line is required."});
  const id="job_"+crypto.randomUUID();
  const job={id,stripId:stripId||null,stripName,characterName,characterReferences,optionCount:count,status:"queued",createdAt:Date.now(),updatedAt:Date.now(),
   lines:lines.map((input,index)=>{
    const x=typeof input==="string"?{text:input,pose:"",direction:"",emotion:""}:input||{};
    return {index,text:String(x.text||""),pose:String(x.pose||""),direction:String(x.direction||""),emotion:String(x.emotion||""),
      options:Array.from({length:count},(_,k)=>({option:k+1,status:"queued",startedAt:null,completedAt:null,imageData:null,error:null}))};
   })};
  job.diversityPlans=diversityPlans(job);
  jobs.set(id,job);res.status(202).json({ok:true,jobId:id,status:"queued"});setImmediate(()=>runJob(job));
 }catch(e){res.status(500).json({error:e?.message||"Could not create job."});}
});
app.get("/jobs/:id",(req,res)=>{
 const job=jobs.get(req.params.id);if(!job)return res.status(404).json({error:"Job not found on this server process."});
 const {characterReferences,...safe}=job;res.json({ok:true,...safe});
});
app.post("/jobs/:id/retry",(req,res)=>{
 const job=jobs.get(req.params.id);if(!job)return res.status(404).json({error:"Job not found."});
 const li=Number(req.body?.lineIndex),op=Number(req.body?.option);
 if(!job.lines[li]||op<1||op>job.optionCount)return res.status(400).json({error:"Invalid lineIndex/option."});
 res.status(202).json({ok:true});setImmediate(()=>generateOne(job,li,op));
});
app.listen(port,"0.0.0.0",()=>console.log(`Cartoonr backend v2.5 listening on ${port}`));
