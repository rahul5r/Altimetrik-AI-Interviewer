import { NextRequest, NextResponse } from 'next/server';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import mammoth from 'mammoth';

const region = process.env.S3_BUCKET_REGION || process.env.AWS_REGION || process.env.REGION || 'us-east-1';

const sharedCredentials =
  (process.env.AWS_ACCESS_KEY_ID || process.env.ACCESS_KEY_ID) &&
    (process.env.AWS_SECRET_ACCESS_KEY || process.env.SECRET_ACCESS_KEY)
    ? {
      accessKeyId: (process.env.AWS_ACCESS_KEY_ID || process.env.ACCESS_KEY_ID) as string,
      secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || process.env.SECRET_ACCESS_KEY) as string,
    }
    : undefined;

const s3Client = new S3Client({
  region,
  ...(sharedCredentials ? { credentials: sharedCredentials } : {}),
});

const bedrockClient = new BedrockRuntimeClient({
  region,
  ...(sharedCredentials ? { credentials: sharedCredentials } : {}),
});

const MODEL_ID = process.env.MODEL_NAME || 'amazon.nova-lite-v1:0';
const INFERENCE_PROFILE_ID =
  process.env.BEDROCK_INFERENCE_PROFILE_ID ||
  process.env.BEDROCK_INFERENCE_PROFILE_ARN ||
  '';
const FALLBACK_MODEL_ID = 'amazon.nova-lite-v1:0';
const MAX_TEXT_CHARS = 16000;

function isModelRoutingError(err: any): boolean {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('on-demand throughput') ||
    msg.includes('inference profile') ||
    msg.includes('validationexception')
  );
}

async function invokeScoringModel(payload: any): Promise<any> {
  const modelIdsToTry: string[] = [];

  if (INFERENCE_PROFILE_ID) modelIdsToTry.push(INFERENCE_PROFILE_ID);
  if (MODEL_ID) modelIdsToTry.push(MODEL_ID);
  if (!modelIdsToTry.includes(FALLBACK_MODEL_ID)) {
    modelIdsToTry.push(FALLBACK_MODEL_ID);
  }

  let lastErr: any;
  for (const modelId of modelIdsToTry) {
    try {
      return await bedrockClient.send(
        new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(payload),
        }),
      );
    } catch (err: any) {
      lastErr = err;
      if (!isModelRoutingError(err)) {
        throw err;
      }
    }
  }

  throw lastErr || new Error('Failed to invoke Bedrock model');
}

function clampScore(value: any): number {
  const n = typeof value === 'number' ? value : Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function extractDriveFileId(urlValue: string): string | null {
  try {
    const parsed = new URL(urlValue.trim());
    if (!parsed.hostname.toLowerCase().includes('drive.google.com')) return null;

    const qId = parsed.searchParams.get('id');
    if (qId) return qId;

    const parts = parsed.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'd');
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];

    return null;
  } catch {
    return null;
  }
}

function toDriveDownloadUrl(inputUrl: string): string {
  const id = extractDriveFileId(inputUrl);
  if (!id) return inputUrl;
  return `https://drive.google.com/uc?export=download&id=${id}`;
}

function inferExtension(fileName: string, contentType: string): 'pdf' | 'txt' | 'docx' | 'unknown' {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.pdf') || contentType.includes('pdf')) return 'pdf';
  if (lower.endsWith('.txt') || contentType.includes('text/plain')) return 'txt';
  if (
    lower.endsWith('.docx') ||
    contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  ) {
    return 'docx';
  }
  return 'unknown';
}

async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  try {
    const pdfParseMod: any = await import('pdf-parse');
    const pdfParse = pdfParseMod.default || pdfParseMod;
    const parsed = await pdfParse(buffer);
    return String(parsed?.text || '').trim();
  } catch {
    return '';
  }
}

async function extractTextFromBuffer(params: {
  buffer: Buffer;
  extension: 'pdf' | 'txt' | 'docx' | 'unknown';
}): Promise<string> {
  const { buffer, extension } = params;

  if (extension === 'txt') {
    return buffer.toString('utf-8').trim();
  }

  if (extension === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return String(result?.value || '').trim();
  }

  if (extension === 'pdf') {
    const text = await parsePdfBuffer(buffer);
    if (text) return text;
    return buffer.toString('utf-8').replace(/\s+/g, ' ').trim();
  }

  return buffer.toString('utf-8').replace(/\s+/g, ' ').trim();
}

async function fetchResumeTextFromDrive(driveLink: string): Promise<string> {
  const downloadUrl = toDriveDownloadUrl(driveLink);
  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`Failed to download resume from Google Drive (${response.status})`);
  }

  const arr = await response.arrayBuffer();
  const buffer = Buffer.from(arr);
  if (buffer.length === 0) throw new Error('Resume file is empty');

  const contentDisposition = response.headers.get('content-disposition') || '';
  const fileNameMatch = contentDisposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
  const fileName = decodeURIComponent(fileNameMatch?.[1] || 'resume');
  const contentType = response.headers.get('content-type') || '';
  const extension = inferExtension(fileName, contentType);

  return extractTextFromBuffer({ buffer, extension });
}

async function fetchJdTextFromS3(jdS3Key: string): Promise<string> {
  const bucketName =
    process.env.NEXT_PUBLIC_AWS_S3_BUCKET_NAME ||
    process.env.AWS_S3_BUCKET_NAME ||
    process.env.S3_BUCKET_NAME;

  if (!bucketName) {
    throw new Error('S3 bucket name not configured');
  }

  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: jdS3Key,
    }),
  );

  const bytes = await response.Body?.transformToByteArray();
  const buffer = Buffer.from(bytes || []);
  if (buffer.length === 0) throw new Error('JD file is empty or inaccessible');

  const extension = inferExtension(jdS3Key, String(response.ContentType || ''));
  return extractTextFromBuffer({ buffer, extension });
}

function buildPrompt(params: { candidateName: string; resumeText: string; jdText: string }) {
  const { candidateName, resumeText, jdText } = params;
  return `
You are an AI recruitment screening assistant for a company's interview shortlisting workflow.
Evaluate how well the candidate resume matches the Job Description for interview eligibility.

Scoring guidance (0-100 total):
- 35 points: Core skills and tools match
- 30 points: Must-have JD requirements coverage
- 20 points: Relevant project/experience alignment
- 15 points: Role readiness and profile quality

Return only valid JSON in this exact schema:
{
  "score": <number 0-100>,
  "label": "Strong Fit" | "Moderate Fit" | "Needs Review" | "Low Fit",
  "summary": "<max 2 lines concise recruiter summary>",
  "strengths": ["<short bullet>", "<short bullet>", "<short bullet>"],
  "gaps": ["<short bullet>", "<short bullet>", "<short bullet>"]
}

Candidate Name: ${candidateName}

Job Description:
${jdText.slice(0, MAX_TEXT_CHARS)}

Resume:
${resumeText.slice(0, MAX_TEXT_CHARS)}
`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const candidateName = String(body?.candidateName || 'Candidate');
    const resumeDriveLink = String(body?.resumeDriveLink || '').trim();
    const jdS3Key = String(body?.jdS3Key || '').trim();

    if (!resumeDriveLink) {
      return NextResponse.json({ error: 'resumeDriveLink is required' }, { status: 400 });
    }

    if (!jdS3Key) {
      return NextResponse.json({ error: 'jdS3Key is required' }, { status: 400 });
    }

    const [resumeTextRaw, jdTextRaw] = await Promise.all([
      fetchResumeTextFromDrive(resumeDriveLink),
      fetchJdTextFromS3(jdS3Key),
    ]);

    const resumeText = resumeTextRaw.slice(0, MAX_TEXT_CHARS);
    const jdText = jdTextRaw.slice(0, MAX_TEXT_CHARS);

    if (!resumeText.trim()) {
      return NextResponse.json({ error: 'Could not parse resume content' }, { status: 422 });
    }

    if (!jdText.trim()) {
      return NextResponse.json({ error: 'Could not parse JD content' }, { status: 422 });
    }

    const payload = {
      schemaVersion: 'messages-v1',
      messages: [
        {
          role: 'user',
          content: [{ text: buildPrompt({ candidateName, resumeText, jdText }) }],
        },
      ],
      inferenceConfig: {
        maxTokens: 1200,
        temperature: 0.2,
      },
    };

    const response = await invokeScoringModel(payload);

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    let text = responseBody.output?.message?.content?.[0]?.text || '{}';

    if (text.trimStart().startsWith('```json')) {
      text = text.replace(/^[\s]*```json\s*/, '').replace(/\s*```[\s]*$/, '');
    } else if (text.trimStart().startsWith('```')) {
      text = text.replace(/^[\s]*```\s*/, '').replace(/\s*```[\s]*$/, '');
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {
        score: 0,
        label: 'Needs Review',
        summary: 'Model response was not parseable. Review manually.',
        strengths: [],
        gaps: ['Scoring parse failure'],
      };
    }

    const score = clampScore(parsed.score);
    const label = String(parsed.label || (score >= 80 ? 'Strong Fit' : score >= 60 ? 'Moderate Fit' : score >= 40 ? 'Needs Review' : 'Low Fit'));
    const summary = String(parsed.summary || 'Screening completed.');
    const strengths = Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 5).map((x: any) => String(x)) : [];
    const gaps = Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, 5).map((x: any) => String(x)) : [];

    return NextResponse.json({
      score,
      label,
      summary,
      strengths,
      gaps,
    });
  } catch (err: any) {
    console.error('Score Candidate Error:', err);
    return NextResponse.json({ error: err.message || 'Failed to score candidate' }, { status: 500 });
  }
}
