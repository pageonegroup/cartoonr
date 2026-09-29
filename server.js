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
 1:"Use a close or half-body composition when appropriate, with strong readable expression.",
 2:"Use a clearly different camera distance and composition from option 1; full-body or three-quarter body when appropriate.",
 3:"Use a clearly different composition from options 1 and 2, changing crop and character placement."
};

app.get("/",(_q,res)=>res.json({ok:true,service:"cartoonr-backend",version:"2.2-bubble-lock",model:"gpt-image-2",backgroundJobs:true}));
app.get("/health",(_q,res)=>res.json({ok:true,version:"2.2-bubble-lock",openaiConfigured:Boolean(process.env.OPENAI_API_KEY),jobs:jobs.size}));

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

function promptFor({characterName,line,option}){
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

OPTION ${option}
${dirs[option]||dirs[1]}
Variation may change framing, placement, camera distance, and secondary body language, but MUST preserve every user-required action, prop, and emotion.

DIVERSITY
Do not default to pointing, raised index finger, shrugging, or hands on hips unless explicitly requested. Make this option compositionally distinct from the other options.

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
   const r=await client.images.edit({model:"gpt-image-2",image:images,prompt:promptFor({characterName:job.characterName,line,option}),size:"1024x1024",quality:"high",output_format:"png",n:1});
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
app.listen(port,"0.0.0.0",()=>console.log(`Cartoonr backend v2.2 listening on ${port}`));
