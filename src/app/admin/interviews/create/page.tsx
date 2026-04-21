'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import * as ExcelJS from 'exceljs';
import * as mammoth from 'mammoth/mammoth.browser';
import { Upload, Plus, FileSpreadsheet, Loader2, ArrowLeft, Trash2, ShieldCheck, GraduationCap, Users, ChevronDown, ChevronUp } from 'lucide-react';
import Link from 'next/link';

type CandidateUploadRow = {
  email: string;
  name: string;
  passkey: string;
  resumeDriveLink?: string;
  selected?: boolean;
  scoreStatus?: 'idle' | 'scoring' | 'done' | 'error';
  score?: number;
  scoreLabel?: string;
  scoreSummary?: string;
  scoreError?: string;
};

export default function CreateTest() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [questions, setQuestions] = useState<{ sl_no?: number, category?: string, question: string, answer: string, key_points: string[], follow_up_depth?: number }[]>([{ question: '', answer: '', key_points: [], follow_up_depth: 2 }]);
  const [candidates, setCandidates] = useState<CandidateUploadRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [jdFileName, setJdFileName] = useState('');
  const [jdS3Key, setJdS3Key] = useState('');
  const [jdUploading, setJdUploading] = useState(false);
  const [jdPreviewUrl, setJdPreviewUrl] = useState('');
  const [jdMimeType, setJdMimeType] = useState('');
  const [showJdPreview, setShowJdPreview] = useState(false);
  const [jdPreviewText, setJdPreviewText] = useState('');
  const [jdPreviewHtml, setJdPreviewHtml] = useState('');

  const selectedCount = candidates.filter((c) => c.selected).length;

  const toggleCandidateSelection = (index: number) => {
    setCandidates((prev) => prev.map((candidate, i) => {
      if (i !== index) return candidate;
      return { ...candidate, selected: !candidate.selected };
    }));
  };

  const toggleSelectAllCandidates = () => {
    const shouldSelectAll = candidates.some((c) => !c.selected);
    setCandidates((prev) => prev.map((candidate) => ({ ...candidate, selected: shouldSelectAll })));
  };

  const scoreCandidateAtIndex = async (index: number) => {
    const candidate = candidates[index];
    if (!candidate) return;
    if (!candidate.resumeDriveLink) {
      setCandidates((prev) => prev.map((row, i) => i === index
        ? { ...row, scoreStatus: 'error', scoreError: 'Missing resume link' }
        : row));
      return;
    }
    if (!jdS3Key) {
      setError('Upload JD before scoring candidates.');
      return;
    }

    setCandidates((prev) => prev.map((row, i) => i === index
      ? { ...row, scoreStatus: 'scoring', scoreError: '' }
      : row));

    try {
      const res = await fetch('/api/score-candidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateName: candidate.name,
          resumeDriveLink: candidate.resumeDriveLink,
          jdS3Key,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Scoring failed');
      }

      setCandidates((prev) => prev.map((row, i) => i === index
        ? {
          ...row,
          scoreStatus: 'done',
          score: data.score,
          scoreLabel: data.label,
          scoreSummary: data.summary,
          scoreError: '',
        }
        : row));
    } catch (err: any) {
      setCandidates((prev) => prev.map((row, i) => i === index
        ? { ...row, scoreStatus: 'error', scoreError: err.message || 'Scoring failed' }
        : row));
    }
  };

  const handleScoreAllCandidates = async () => {
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i]?.resumeDriveLink) {
        // Keep sequential calls to avoid Bedrock throttling on large sheets.
        await scoreCandidateAtIndex(i);
      }
    }

    setCandidates((prev) => {
      return [...prev].sort((a, b) => {
        const scoreA = typeof a.score === 'number' ? a.score : 0;
        const scoreB = typeof b.score === 'number' ? b.score : 0;
        return scoreB - scoreA;
      });
    });
  };

  const handleJDUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowed = [
      'application/pdf',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];

    if (!allowed.includes(file.type)) {
      setError('Only PDF, TXT, and DOCX files are allowed for JD upload.');
      return;
    }

    setJdUploading(true);
    setError('');

    try {
      const cleanedName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const key = `jds/${timestamp}_${cleanedName}`;

      const presignRes = await fetch('/api/s3-presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upload',
          fileName: key,
          fileType: file.type,
        }),
      });

      const presignData = await presignRes.json();
      if (!presignRes.ok || !presignData?.signedUrl) {
        throw new Error(presignData?.error || 'Failed to generate upload URL for JD.');
      }

      const uploadRes = await fetch(presignData.signedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type,
        },
        body: file,
      });

      if (!uploadRes.ok) {
        throw new Error('Failed to upload JD file to S3.');
      }

      setJdFileName(file.name);
      setJdS3Key(key);
      setJdMimeType(file.type);
      setShowJdPreview(false);
      setJdPreviewText('');
      setJdPreviewHtml('');

      if (file.type === 'text/plain') {
        const txt = await file.text();
        setJdPreviewText(txt);
      } else if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer });
        setJdPreviewHtml(result.value || '');
      }

      const getRes = await fetch('/api/s3-presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'get',
          fileName: key,
        }),
      });

      const getData = await getRes.json();
      if (!getRes.ok || !getData?.signedUrl) {
        throw new Error(getData?.error || 'Failed to generate JD preview URL.');
      }

      setJdPreviewUrl(getData.signedUrl);
    } catch (err: any) {
      setError(err.message || 'JD upload failed.');
    } finally {
      setJdUploading(false);
      e.target.value = '';
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const worksheet = workbook.worksheets[0];

      if (!worksheet) {
        setError('No worksheet found in Excel file.');
        return;
      }

      // Helper: ExcelJS returns hyperlinked cells (like emails) as objects
      const getCellText = (cellValue: any): string => {
        if (!cellValue) return '';
        if (typeof cellValue === 'string') return cellValue.trim();
        if (typeof cellValue === 'object' && cellValue.text) return String(cellValue.text).trim();
        if (typeof cellValue === 'object' && cellValue.result) return String(cellValue.result).trim();
        return String(cellValue).trim();
      };

      const parsed: CandidateUploadRow[] = [];
      const headers: Record<number, string> = {};

      const normalizeHeader = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

      const getByHeaderAliases = (
        row: ExcelJS.Row,
        aliases: string[],
        fallbackCol?: number,
      ): string => {
        const normalizedAliases = aliases.map((a) => normalizeHeader(a));
        for (const [colKey, header] of Object.entries(headers)) {
          if (normalizedAliases.includes(normalizeHeader(header))) {
            return getCellText(row.getCell(Number(colKey)).value);
          }
        }
        if (fallbackCol) {
          return getCellText(row.getCell(fallbackCol).value);
        }
        return '';
      };

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) {
          row.eachCell((cell, colNumber) => {
            headers[colNumber] = getCellText(cell.value);
          });
          return;
        }

        const name = getByHeaderAliases(row, ['name', 'candidate name'], 1);
        const email = getByHeaderAliases(row, ['email', 'email id', 'email address'], 2);
        const resumeDriveLink = getByHeaderAliases(
          row,
          ['resume drive link', 'resumedrivelink', 'resume link', 'resumelink', 'drive link', 'drivelink'],
          3,
        );

        if (email) {
          parsed.push({
            email: email.toLowerCase(),
            name: name || 'Candidate',
            passkey: Math.random().toString(36).slice(-8).toUpperCase(),
            resumeDriveLink,
            selected: false,
            scoreStatus: 'idle',
          });
        }
      });

      setCandidates(parsed.filter(c => c.email));
    } catch (err) {
      setError('Failed to parse Excel file. Ensure it has Name and Email columns.');
    }
  };

  const handleQuestionUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const worksheet = workbook.worksheets[0];

      if (!worksheet) {
        setError('No worksheet found in Excel file.');
        return;
      }

      const parsed: any[] = [];
      let headerMap: Record<number, string> = {};

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) {
          row.eachCell((cell, colNumber) => {
            headerMap[colNumber] = String(cell.value || '').toLowerCase().trim();
          });
          return;
        }

        const getCol = (name: string) => {
          const col = Object.entries(headerMap).find(([_, v]) => v === name)?.[0];
          return col ? String(row.getCell(Number(col)).value ?? '').trim() : '';
        };

        const question = getCol('question');
        if (!question) return;

        const keyPoints: string[] = [];
        for (let n = 1; n <= 5; n++) {
          const colEntry = Object.entries(headerMap).find(([_, v]) =>
            v === `coverage point ${n}` || v === `coverage point${n}` || v === `coveragepoint${n}`
          );
          if (colEntry) {
            const val = String(row.getCell(Number(colEntry[0])).value ?? '').trim();
            if (val) keyPoints.push(val);
          }
        }

        if (keyPoints.length === 0) {
          const kpCol = Object.entries(headerMap).find(([_, v]) =>
            v === 'keypoints' || v === 'key_points' || v === 'key points'
          )?.[0];
          if (kpCol) {
            const raw = String(row.getCell(Number(kpCol)).value ?? '');
            raw.split(';').map(k => k.trim()).filter(Boolean).forEach(k => keyPoints.push(k));
          }
        }

        const category = getCol('category');
        const slNoRaw = getCol('sl no') || getCol('sl.no') || getCol('slno') || getCol('s.no') || getCol('sno');
        const followUpDepthRaw = getCol('follow_up_depth') || getCol('follow up depth') || getCol('followupdepth');

        parsed.push({
          sl_no: slNoRaw ? Number(slNoRaw) : undefined,
          category: category || undefined,
          question,
          answer: getCol('answer'),
          key_points: keyPoints,
          follow_up_depth: followUpDepthRaw ? Number(followUpDepthRaw) : 2,
        });
      });

      if (parsed.length > 0) {
        if (questions.length === 1 && !questions[0].question) {
          setQuestions(parsed);
        } else {
          setQuestions([...questions, ...parsed]);
        }
        setError('');
      } else {
        setError('No questions found. Ensure the sheet has a "Question" column and at least one "Coverage point" column.');
      }
    } catch (err) {
      setError('Failed to parse Excel file. Check the column structure and try again.');
    }
  };

  const handleSave = async () => {
    if (!title) return setError('Title is required');
    if (questions.some(q => !q.question.trim())) return setError('All questions must be filled');
    if (candidates.length === 0) return setError('At least one candidate is required from Excel');
    if (selectedCount === 0) return setError('Select at least one candidate to schedule interview invites.');

    setLoading(true);
    setError('');

    try {
      const { data: interview, error: iError } = await supabase
        .from('interviews')
        .insert([{
          title,
          question_bank: questions
        }])
        .select()
        .single();

      if (iError || !interview) throw iError || new Error('Failed to create interview');

      const selectedCandidates = candidates.filter((c) => c.selected);

      const candidatesToInsert = selectedCandidates.map((c) => ({
        email: c.email,
        name: c.name,
        passkey: c.passkey,
        interview_id: interview.id,
        is_allowed: true,
      }));

      const { data: insertedCandidates, error: cError } = await supabase
        .from('candidates')
        .insert(candidatesToInsert)
        .select('id, email');

      if (cError) throw cError;

      const candidatesByEmail = new Map(selectedCandidates.map((c) => [c.email.toLowerCase(), c]));
      let resumeImported = 0;
      let resumeFailed = 0;

      const inserted = Array.isArray(insertedCandidates) ? insertedCandidates : [];
      for (const savedCandidate of inserted) {
        const sourceCandidate = candidatesByEmail.get(String(savedCandidate.email || '').toLowerCase());
        if (!sourceCandidate?.resumeDriveLink) continue;

        try {
          const res = await fetch('/api/upload-resume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'ingestDriveLink',
              interviewId: interview.id,
              candidateId: savedCandidate.id,
              candidateName: sourceCandidate.name,
              driveUrl: sourceCandidate.resumeDriveLink,
            }),
          });

          if (!res.ok) {
            resumeFailed += 1;
            continue;
          }
          resumeImported += 1;
        } catch {
          resumeFailed += 1;
        }
      }

      const params = new URLSearchParams({
        resumeImported: String(resumeImported),
        resumeFailed: String(resumeFailed),
      });
      router.push(`/admin/interviews/${interview.id}/send-email?${params.toString()}`);
    } catch (err: any) {
      setError(err.message || 'Error saving test');
      setLoading(false);
    }
  };

  return (
    <div className="space-y-10 animate-in fade-in duration-500 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/admin/dashboard" className="w-12 h-12 bg-white border border-slate-200 rounded-2xl flex items-center justify-center text-slate-400 hover:text-blue-600 hover:border-blue-200 transition-all shadow-sm">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight">Create Assessment</h1>
            <p className="text-slate-500 font-medium">Design your custom interview flow and invite candidates.</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-100 text-red-600 px-6 py-4 rounded-2xl font-bold flex items-center gap-3 animate-in shake duration-300">
          <Trash2 size={20} />
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-10">
        {/* Title Section */}
        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-10 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-8 opacity-[0.03] pointer-events-none">
            <GraduationCap size={120} />
          </div>
          <h2 className="text-xl font-bold mb-8 text-slate-900 flex items-center gap-3">
            <ShieldCheck size={24} className="text-blue-500" />
            Interview Identity
          </h2>
          <div className="max-w-2xl">
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-3 ml-1">Assessment Title / Role Name</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-slate-900 font-bold text-lg focus:outline-none focus:border-blue-500 focus:bg-white transition-all outline-none shadow-sm"
              placeholder="e.g. Senior Frontend Engineer"
            />
          </div>
        </section>

        {/* Job Description Section */}
        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-10 shadow-sm relative overflow-hidden">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-3">
                <FileSpreadsheet size={24} className="text-blue-500" />
                Job Description
              </h2>
              <p className="text-sm text-slate-500 font-medium mt-2">Upload JD file in <span className="text-slate-900 font-bold">PDF, TXT, or DOCX</span> format.</p>
            </div>

            <label className="cursor-pointer bg-slate-900 hover:bg-black px-8 py-4 rounded-2xl flex items-center gap-3 transition-all active:scale-95 shadow-xl text-white">
              {jdUploading ? <Loader2 size={20} className="animate-spin" /> : <Upload size={20} />}
              <span className="font-bold text-sm">{jdUploading ? 'Uploading JD...' : 'Upload JD'}</span>
              <input type="file" accept=".pdf,.txt,.docx" className="hidden" onChange={handleJDUpload} disabled={jdUploading} />
            </label>
          </div>

          {jdPreviewUrl && (
            <div className="mt-6 border border-slate-200 rounded-2xl overflow-hidden bg-slate-50">
              <button
                type="button"
                onClick={() => setShowJdPreview((prev) => !prev)}
                className="w-full px-4 py-3 border-b border-slate-200 bg-white flex items-center justify-between gap-3"
              >
                <p className="text-xs font-black text-slate-500 uppercase tracking-widest">JD Preview</p>
                <span className="text-slate-500">
                  {showJdPreview ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </span>
              </button>

              {showJdPreview && (
                <>
                  {jdMimeType === 'application/pdf' ? (
                    <iframe
                      src={jdPreviewUrl}
                      title="JD Preview"
                      className="w-full h-[420px] bg-white"
                    />
                  ) : jdMimeType === 'text/plain' ? (
                    <div className="p-4 bg-white">
                      <pre className="text-sm text-slate-700 whitespace-pre-wrap break-words max-h-[420px] overflow-auto">{jdPreviewText || 'No preview available.'}</pre>
                    </div>
                  ) : (
                    <div className="p-4 bg-white text-sm text-slate-700 max-h-[420px] overflow-auto leading-relaxed" dangerouslySetInnerHTML={{ __html: jdPreviewHtml || '<p>No preview available.</p>' }} />
                  )}
                </>
              )}
            </div>
          )}
        </section>

        {/* Question Bank Section */}
        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-10 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-6">
            <div>
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-3">
                <FileSpreadsheet size={24} className="text-blue-500" />
                Question Bank
              </h2>
              <p className="text-xs text-slate-400 font-medium mt-2">Upload Excel with: <span className="text-slate-700 font-bold">Sl No, Category, Question, Coverage Point 1–5, follow_up_depth</span></p>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <label className="cursor-pointer bg-slate-50 hover:bg-white border border-slate-200 hover:border-emerald-400 px-5 py-2.5 rounded-2xl flex items-center gap-2.5 transition-all active:scale-95 shadow-sm">
                <FileSpreadsheet className="text-emerald-500" size={18} />
                <span className="font-bold text-sm text-slate-600">Import Excel</span>
                <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleQuestionUpload} />
              </label>

              <button
                onClick={() => setQuestions([...questions, { question: '', answer: '', key_points: [], follow_up_depth: 2 }])}
                className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-2xl font-bold text-sm shadow-lg shadow-blue-600/20 active:scale-95 flex items-center gap-2"
              >
                <Plus size={16} /> Add Row
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-200 shadow-sm">
            <table className="w-full text-left text-sm min-w-[1000px]">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3.5 font-black text-slate-400 text-[10px] uppercase tracking-widest w-12 text-center border-r border-slate-100">#</th>
                  <th className="px-4 py-3.5 font-black text-slate-400 text-[10px] uppercase tracking-widest w-44 border-r border-slate-100">Category</th>
                  <th className="px-4 py-3.5 font-black text-slate-400 text-[10px] uppercase tracking-widest min-w-[300px] border-r border-slate-100">Question</th>
                  <th className="px-4 py-3.5 font-black text-slate-400 text-[10px] uppercase tracking-widest min-w-[260px] border-r border-slate-100">Coverage Points</th>
                  <th className="px-4 py-3.5 font-black text-slate-400 text-[10px] uppercase tracking-widest w-24 text-center border-r border-slate-100">Depth</th>
                  <th className="px-4 py-3.5 font-black text-slate-400 text-[10px] uppercase tracking-widest w-12 text-center">Del</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {questions.map((q, i) => (
                  <tr key={i} className="hover:bg-blue-50/30 group transition-colors">
                    <td className="px-4 py-3 text-center text-slate-400 font-black text-xs border-r border-slate-100 bg-slate-50/50">
                      {q.sl_no || i + 1}
                    </td>
                    <td className="p-0 border-r border-slate-100">
                      <input
                        type="text"
                        value={q.category || ''}
                        onChange={(e) => {
                          const newQ = [...questions];
                          newQ[i] = { ...newQ[i], category: e.target.value };
                          setQuestions(newQ);
                        }}
                        className="w-full h-full min-h-[56px] bg-transparent border-none px-4 py-3 text-slate-700 focus:outline-none focus:bg-blue-50/40 transition-all font-medium text-sm placeholder:text-slate-300"
                        placeholder="Category..."
                      />
                    </td>
                    <td className="p-0 border-r border-slate-100">
                      <textarea
                        value={q.question}
                        onChange={(e) => {
                          const newQ = [...questions];
                          newQ[i] = { ...newQ[i], question: e.target.value };
                          setQuestions(newQ);
                        }}
                        className="w-full h-full min-h-[56px] bg-transparent border-none px-4 py-3 text-slate-800 font-bold focus:outline-none focus:bg-blue-50/40 transition-all resize-none text-sm placeholder:text-slate-300"
                        placeholder="Interview question..."
                      />
                    </td>
                    <td className="p-0 border-r border-slate-100">
                      <textarea
                        value={q.key_points.join('; ')}
                        onChange={(e) => {
                          const newQ = [...questions];
                          newQ[i] = { ...newQ[i], key_points: e.target.value.split(';').map(kp => kp.trim()).filter(kp => kp) };
                          setQuestions(newQ);
                        }}
                        className="w-full h-full min-h-[56px] bg-transparent border-none px-4 py-3 text-amber-600 focus:outline-none focus:bg-amber-50/30 transition-all resize-none text-sm placeholder:text-slate-300"
                        placeholder="Point 1; Point 2; Point 3..."
                      />
                    </td>
                    <td className="p-0 border-r border-slate-100">
                      <input
                        type="number"
                        min="0"
                        max="5"
                        value={q.follow_up_depth === undefined ? 2 : q.follow_up_depth}
                        onChange={(e) => {
                          const newQ = [...questions];
                          newQ[i] = { ...newQ[i], follow_up_depth: parseInt(e.target.value) || 0 };
                          setQuestions(newQ);
                        }}
                        className="w-full h-full min-h-[56px] bg-transparent border-none px-4 py-3 text-slate-700 focus:outline-none focus:bg-blue-50/40 transition-all text-center font-bold text-sm"
                      />
                    </td>
                    <td className="p-2 text-center">
                      {questions.length > 1 && (
                        <button
                          onClick={() => setQuestions(questions.filter((_, idx) => idx !== i))}
                          className="p-2 w-full flex justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors"
                          title="Delete Row"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Candidates Section */}
        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-10 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-8 opacity-[0.03] pointer-events-none">
            <Users size={120} />
          </div>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-8 mb-10">
            <div>
              <h2 className="text-xl font-bold mb-1 text-slate-900 flex items-center gap-3">
                <Users size={24} className="text-blue-500" />
                Candidate Invites
              </h2>
              <p className="text-sm text-slate-500 font-medium">Upload Excel with <span className="text-slate-900 font-bold">Name</span>, <span className="text-slate-900 font-bold">Email</span>, and <span className="text-slate-900 font-bold">ResumeDriveLink</span> columns.</p>
            </div>
            <div className="flex items-center gap-3">
              {candidates.length > 0 && (
                <button
                  type="button"
                  onClick={handleScoreAllCandidates}
                  disabled={!jdS3Key || candidates.every((c) => !c.resumeDriveLink)}
                  className="bg-white border border-slate-200 hover:border-blue-300 px-6 py-4 rounded-2xl flex items-center gap-2 transition-all active:scale-95 shadow-sm text-slate-700 disabled:opacity-50"
                >
                  <span className="font-bold text-sm">Score All</span>
                </button>
              )}
              <label className="cursor-pointer bg-slate-900 hover:bg-black px-8 py-4 rounded-2xl flex items-center gap-3 transition-all active:scale-95 shadow-xl text-white">
                <Upload size={20} />
                <span className="font-bold text-sm">Upload Candidates</span>
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileUpload} />
              </label>
            </div>
          </div>

          {candidates.length > 0 && (
            <div className="animate-in fade-in slide-in-from-top-2 duration-500">
              <div className="flex items-center gap-2 mb-6 px-4 py-2 bg-emerald-50 text-emerald-700 rounded-xl w-fit text-xs font-black uppercase tracking-widest border border-emerald-100">
                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                {candidates.length} Profiles Ready {selectedCount > 0 ? `| ${selectedCount} Selected` : ''}
              </div>
              <div className="overflow-hidden rounded-3xl border border-slate-100 shadow-sm">
                <table className="w-full text-left text-sm border-collapse">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest text-center w-12">
                        <input
                          type="checkbox"
                          checked={candidates.length > 0 && selectedCount === candidates.length}
                          onChange={toggleSelectAllCandidates}
                          className="w-4 h-4 rounded border-slate-300"
                        />
                      </th>
                      <th className="px-6 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest">Name</th>
                      <th className="px-6 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest">Email Address</th>
                      <th className="px-6 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest">Resume Link</th>
                      <th className="px-6 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 bg-white">
                    {candidates.map((c, i) => (
                      <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                        <td className="px-4 py-4 text-center">
                          <input
                            type="checkbox"
                            checked={!!c.selected}
                            onChange={() => toggleCandidateSelection(i)}
                            className="w-4 h-4 rounded border-slate-300"
                          />
                        </td>
                        <td className="px-6 py-4 font-bold text-slate-900">{c.name}</td>
                        <td className="px-6 py-4 text-slate-500 font-medium">{c.email}</td>
                        <td className="px-6 py-4">
                          {c.resumeDriveLink ? (
                            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-emerald-50 text-emerald-700 border border-emerald-100">
                              Present
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-500 border border-slate-200">
                              Missing
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {c.scoreStatus === 'scoring' && <span className="text-xs font-bold text-blue-600">Scoring...</span>}
                          {c.scoreStatus === 'done' && (
                            <div className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-blue-50 text-blue-700 border border-blue-100">
                              {c.score}% {c.scoreLabel ? `- ${c.scoreLabel}` : ''}
                            </div>
                          )}
                          {c.scoreStatus === 'error' && <span className="text-xs font-bold text-red-600">{c.scoreError || 'Failed'}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        <div className="flex justify-center pt-8">
          <button
            onClick={handleSave}
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-700 text-white font-black text-lg rounded-[2rem] px-16 py-6 flex items-center gap-4 transition-all shadow-2xl shadow-blue-600/30 active:scale-95 disabled:opacity-50"
          >
            {loading ? <Loader2 className="animate-spin" size={24} /> : <>Initialize Assessment & Send Mail</>}
          </button>
        </div>
      </div>
    </div>
  );
}
