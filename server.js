import express from "express";
import cors from "cors";
import OpenAI, { toFile } from "openai";
import crypto from "crypto";

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: "80mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const jobs = new Map();

app.get("/", (_req,res)=>res.json({ok:true,service:"cartoonr-backend",version:"2.0",model:"gpt-image-2",backgroundJobs:true}));
app.get("/health", (_req,res)=>res.json({ok:true,openaiConfigured:Boolean(process.env.OPENAI_API_KEY),jobs:jobs.size}));

function parseDataUrl(dataUrl,index){
  const m=/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/s.exec(dataUrl||"");
  if(!m) throw new Error(`Reference ${index+1} is not a supported image.`);
  const mime=m[1]==="image/jpg"?"image/jpeg":m[1];
  const ext=mime==="image/png"?"png":mime==="image/webp"?"webp":"jpg";
  return {mime,ext,buffer:Buffer.from(m[2],"base64")};
}


const CARTOONR_BUBBLE_STYLE = {
  fill: "#FFFDF7",
  outline: {
    color: "#163746",
    appearance: "hand-drawn ink",
    weight: "medium-heavy",
    uniformity: "slightly irregular",
    smoothness: "organic"
  },
  shape: {
    primary: "rounded hand-drawn rectangle",
    secondary: "soft irregular comic bubble",
    corners: "very rounded",
    symmetry: "imperfect",
    geometry: "organic, never vector-perfect"
  },
  tail: {
    style: "short integrated comic tail",
    direction: "toward speaker",
    length: "short",
    shape: "slightly curved triangular",
    position: "adaptive"
  },
  padding: "generous",
  shadow: false,
  gradient: false,
  texture: false,
  lettering: {
    type: "hand-drawn comic lettering",
    case: "uppercase",
    color: "#163746",
    weight: "bold",
    stroke: "rounded monoline",
    characterWidth: "naturally variable",
    characterHeight: "slightly variable",
    baseline: "subtly irregular",
    tracking: "moderately open",
    lineSpacing: "compact but readable",
    alignment: "center",
    terminals: "rounded"
  }
};

const dirs={
  1:"Use a composition best suited to the line; often half-body or three-quarter body. Place the character left or right only when that creates strong negative space for the bubble.",
  2:"Make this clearly different from option 1. Consider full-body, seated, standing, or a distinct expressive gesture. Use a simple prop only when essential to the meaning.",
  3:"Make this clearly different from options 1 and 2. Consider a close-up, head-and-shoulders, or another emotionally strong framing with different placement and gesture."
};

function promptFor({characterName,line,option}){
return `Create ONE finished square cartoon artcard for "${characterName||"the supplied character"}".

REFERENCE LOCK
The uploaded images are the sole visual basis. Preserve the same recognizable character, face construction, age cues, hairstyle, proportions, clothing conventions, stroke/outline character, palette, coloring method, illustration finish, and personality. Do not redesign the character or change the illustration style.

BACKGROUND — HARD RULE
The entire background must be pure solid white (#FFFFFF). No cream, beige, yellow, gradient, texture, scenery, room, landscape, glow, vignette, or colored wash.

SPEECH BUBBLE — LOCKED CARTOONR STYLE
Use this fixed speech-bubble and lettering specification for every artcard:
${JSON.stringify(CARTOONR_BUBBLE_STYLE)}

The visual result must read as genuinely hand-drawn: white/off-white bubble fill; dark blue-black organic medium-heavy outline; very rounded, slightly imperfect contour; short integrated curved triangular tail pointing toward the speaker; generous internal padding; no shadow, gradient, texture, or 3D effect. Lettering must look like bold uppercase hand-drawn comic lettering with rounded monoline strokes, subtly irregular baselines, naturally variable letter widths/heights, moderately open tracking, compact readable line spacing, and centered alignment. Avoid polished typesetting, serif, italic, condensed, geometric sans, or perfectly identical repeated letters.

Include this exact line verbatim:
"${line}"
Do not rewrite, correct, shorten, translate, paraphrase, or add words. Choose line breaks that balance the bubble visually, keep words intact, and never crop or overflow text.

PERFORMANCE
Infer the emotional tone of the line. Let expression, pose, gesture, and body language communicate that tone.

OPTION ${option}
${dirs[option]||dirs[1]}

SAFE COMPOSITION — HARD RULE
Keep EVERY visible element safely inside the canvas with generous white margin on all four sides. Nothing may touch or be cut by the left or right edge: not the character, hair, hands, clothing, props, furniture, plants, hearts, bubble, bubble tail, or decorations. Avoid unnecessary props and decorations. If a prop is used, it must be fully contained with white space around it.

OUTPUT
One square artcard only. Never a collage, triptych, contact sheet, multiple panels, watermark, or extra caption.`;
}

async function prepareImages(refs){
  const out=[];
  for(let i=0;i<refs.length;i++){
    const p=parseDataUrl(refs[i],i);
    out.push(await toFile(p.buffer,`reference-${i+1}.${p.ext}`,{type:p.mime}));
  }
  return out;
}

async function generateOne(job,lineIndex,option){
  const rec=job.lines[lineIndex].options[option-1];
  rec.status="generating"; rec.startedAt=Date.now(); rec.error=null;
  job.updatedAt=Date.now();

  try{
    const images=await prepareImages(job.characterReferences);
    const r=await client.images.edit({
      model:"gpt-image-2",
      image:images,
      prompt:promptFor({characterName:job.characterName,line:job.lines[lineIndex].text,option}),
      size:"1024x1024",
      quality:"high",
      output_format:"png",
      n:1
    });
    const b64=r?.data?.[0]?.b64_json;
    if(!b64) throw new Error("OpenAI returned no image data.");
    rec.imageData=`data:image/png;base64,${b64}`;
    rec.status="complete"; rec.completedAt=Date.now();
  }catch(e){
    rec.status="failed"; rec.error=e?.message||"Generation failed"; rec.completedAt=Date.now();
  }
  job.updatedAt=Date.now();
}

async function runJob(job){
  job.status="running"; job.startedAt=Date.now(); job.updatedAt=Date.now();
  for(let i=0;i<job.lines.length;i++){
    // Three options for the current line run concurrently.
    await Promise.all([1,2,3].map(n=>generateOne(job,i,n)));
  }
  const all=job.lines.flatMap(l=>l.options);
  job.status=all.every(x=>x.status==="complete")?"complete":all.some(x=>x.status==="complete")?"complete_with_errors":"failed";
  job.completedAt=Date.now(); job.updatedAt=Date.now();
}

app.post("/jobs",(req,res)=>{
  try{
    if(!process.env.OPENAI_API_KEY) return res.status(500).json({error:"OPENAI_API_KEY is not configured."});
    const {stripId,stripName="",characterName="",characterReferences=[],lines=[]}=req.body||{};
    if(!Array.isArray(characterReferences)||!characterReferences.length) return res.status(400).json({error:"Character references are required."});
    if(!Array.isArray(lines)||!lines.length) return res.status(400).json({error:"At least one line is required."});

    const id="job_"+crypto.randomUUID();
    const job={
      id,stripId:stripId||null,stripName,characterName,characterReferences,
      status:"queued",createdAt:Date.now(),updatedAt:Date.now(),
      lines:lines.map((text,index)=>({
        index,text,
        options:[1,2,3].map(option=>({option,status:"queued",startedAt:null,completedAt:null,imageData:null,error:null}))
      }))
    };
    jobs.set(id,job);
    res.status(202).json({ok:true,jobId:id,status:"queued"});
    setImmediate(()=>runJob(job)); // continues after browser disconnects
  }catch(e){res.status(500).json({error:e?.message||"Could not create job."});}
});

app.get("/jobs/:id",(req,res)=>{
  const job=jobs.get(req.params.id);
  if(!job) return res.status(404).json({error:"Job not found on this server process."});
  // Do not echo character references back to the browser.
  const {characterReferences,...safe}=job;
  res.json({ok:true,...safe});
});

app.post("/jobs/:id/retry",async(req,res)=>{
  const job=jobs.get(req.params.id);
  if(!job) return res.status(404).json({error:"Job not found."});
  const {lineIndex,option}=req.body||{};
  const li=Number(lineIndex), op=Number(option);
  if(!job.lines[li]||![1,2,3].includes(op)) return res.status(400).json({error:"Invalid lineIndex/option."});
  res.status(202).json({ok:true});
  setImmediate(()=>generateOne(job,li,op));
});

app.listen(port,"0.0.0.0",()=>console.log(`Cartoonr background backend listening on ${port}`));
