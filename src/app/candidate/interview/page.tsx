'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Mic, MicOff, Video, Play, ShieldCheck, BookOpen, CheckCircle2, ArrowRight, Mail, AlertTriangle, User } from 'lucide-react';
import Image from 'next/image';
import logoImg from '../../icon.png';

const sendLogToCmd = (level: string, message: string, details?: any) => {
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, message, details }),
  }).catch(() => { });
};

export default function InterviewRoom() {
  const router = useRouter();

  const [candidate, setCandidate] = useState<any>(null);
  const [interview, setInterview] = useState<any>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const [isStarted, setIsStarted] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [warningMsg, setWarningMsg] = useState('');
  const [showFullscreenPrompt, setShowFullscreenPrompt] = useState(false);
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [showTabWarning, setShowTabWarning] = useState(false);
  const [fullscreenExitCount, setFullscreenExitCount] = useState(0);
  const [supportEmail, setSupportEmail] = useState('');
  const [isUploadComplete, setIsUploadComplete] = useState(
    () => typeof window !== 'undefined' && sessionStorage.getItem('interview_done') === 'true'
  );
  const [isListening, setIsListening] = useState(false);
  const [currentAnswer, setCurrentAnswer] = useState('');
  const [transcript, setTranscript] = useState<{ speaker: 'AI' | 'Candidate', text: string }[]>([]);
  const transcriptRef = useRef<{ speaker: 'AI' | 'Candidate', text: string }[]>([]);
  const [savingStatus, setSavingStatus] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunks = useRef<Blob[]>([]);
  const recognitionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isListeningRef = useRef(false); // ref mirror of isListening — safe to read in closures

  const questionIndex = useRef(-1);
  const candidateAnswers = useRef<{ q?: string, a?: string, followUp?: string, followUpAnswer?: string, followUps?: { q: string, a: string }[], isBreak?: boolean, sessionNo?: number, timestamp?: string, speaker?: string, text?: string }[]>([]);
  const finalizedTextRef = useRef('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const selectedVoiceRef = useRef<SpeechSynthesisVoice | null>(null);

  // ── Evaluator 1 tracking ──────────────────────────────────────────
  const coveragePerQuestion = useRef<{ questionIndex: number, coverage: number }[]>([]);
  const questionsWithFollowUps = useRef<number>(0);
  const followUpsPerQuestion = useRef<{ questionIndex: number, count: number }[]>([]);
  const followUpCountForCurrentQ = useRef(0);  // how many follow-ups asked for current question
  const lastQuestionText = useRef('');
  const emptyAudioAttempts = useRef(0);

  // ── S3 Segmented Storage State ─────────────────────────────────────
  const segmentIndexRef = useRef(1);
  const pendingUploadsRef = useRef<Set<Promise<any>>>(new Set());
  const isResumingRef = useRef(false);
  const uploadQueueRef = useRef<{ blob: Blob; fileName: string; index: number }[]>([]);
  const isProcessingQueueRef = useRef(false);
  const sessionCountRef = useRef(1);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript, currentAnswer]);

  // ── Security: Fullscreen enforcement ─────────────────────────────
  const isInterviewActive = useRef(false);

  const enterFullscreen = () => {
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen();
    else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen();
    else if ((el as any).mozRequestFullScreen) (el as any).mozRequestFullScreen();
    else if ((el as any).msRequestFullscreen) (el as any).msRequestFullscreen();
  };

  const showSecurityWarning = (msg: string) => {
    setWarningMsg(msg);
    setShowWarning(true);
    setTimeout(() => setShowWarning(false), 3000);
  };

  // Block fullscreen exit
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFs =
        !!document.fullscreenElement ||
        !!(document as any).webkitFullscreenElement ||
        !!(document as any).mozFullScreenElement ||
        !!(document as any).msFullscreenElement;

      if (isInterviewActive.current) {
        if (!isFs) {
          // Candidate exited fullscreen, count the violation
          setFullscreenExitCount(prev => prev + 1);
          // ⚠️ Cannot call requestFullscreen() here — browsers require a direct
          // user gesture (click). Show a blocking overlay instead; the button
          // inside it will call enterFullscreen() as a valid user gesture.
          setShowFullscreenPrompt(true);
        } else {
          // Fullscreen restored (e.g. candidate clicked the button)
          setShowFullscreenPrompt(false);
        }
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);

  // ── Security: Block keyboard shortcuts ───────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

      // ─ Block DevTools shortcuts
      if (key === 'F12') { e.preventDefault(); e.stopPropagation(); return; }
      if (ctrl && shift && ['I', 'i', 'J', 'j', 'C', 'c'].includes(key)) { e.preventDefault(); e.stopPropagation(); return; }
      if (ctrl && ['U', 'u'].includes(key)) { e.preventDefault(); e.stopPropagation(); return; }
      if (ctrl && ['S', 's'].includes(key)) { e.preventDefault(); e.stopPropagation(); return; }
      if (ctrl && ['P', 'p'].includes(key)) { e.preventDefault(); e.stopPropagation(); return; }

      // ─ Block page refresh
      if (key === 'F5') { e.preventDefault(); e.stopPropagation(); return; }
      if (ctrl && ['R', 'r'].includes(key)) { e.preventDefault(); e.stopPropagation(); return; }
      if (ctrl && shift && ['R', 'r'].includes(key)) { e.preventDefault(); e.stopPropagation(); return; }

      // ─ Block fullscreen exit keys — only during active interview
      if (isInterviewActive.current) {
        if (key === 'Escape') { e.preventDefault(); e.stopPropagation(); enterFullscreen(); return; }
        if (['F', 'f', 'F11'].includes(key) && !ctrl && !shift) { e.preventDefault(); e.stopPropagation(); return; }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // ── Security: Block right-click context menu ──────────────────────
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => { e.preventDefault(); };
    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  // ── Security: Warn on page unload / refresh ───────────────────────
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isInterviewActive.current) {
        e.preventDefault();
        e.returnValue = 'Your interview is in progress. Leaving will forfeit your session.';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // ── Security: Detect tab switching (separate from fullscreen) ───────
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && isInterviewActive.current) {
        // Increment violation counter and show a temporary amber toast
        setTabSwitchCount(prev => prev + 1);
        setShowTabWarning(true);
        setTimeout(() => setShowTabWarning(false), 4000);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // ── Auto-enter fullscreen on first interaction after exit ──────────
  // pointerdown IS a trusted user gesture — requestFullscreen() succeeds.
  // This fires the instant the candidate interacts with anything on the
  // overlay (or anywhere on the page), without them needing to find and
  // explicitly click a button.
  useEffect(() => {
    if (!showFullscreenPrompt) return;
    const handler = () => { enterFullscreen(); };
    document.addEventListener('pointerdown', handler, { once: true, capture: true });
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [showFullscreenPrompt]);

  // Fetch support email from server-side API
  useEffect(() => {
    fetch('/api/support-email')
      .then(r => r.json())
      .then(d => { if (d.email) setSupportEmail(d.email); })
      .catch(() => { });
  }, []);

  useEffect(() => {
    const cid = localStorage.getItem('candidate_id');
    const iid = localStorage.getItem('interview_id');
    if (!cid || !iid) return router.push('/candidate/login');

    if (sessionStorage.getItem('interview_done') === 'true') {
      navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then(ms => ms.getTracks().forEach(t => t.stop()))
        .catch(() => { });
      setIsCompleted(true);
      return;
    }

    const init = async () => {
      const [cRes, iRes] = await Promise.all([
        supabase.from('candidates').select('*').eq('id', cid).single(),
        supabase.from('interviews').select('*').eq('id', iid).single()
      ]);
      const cData = cRes.data;
      setCandidate(cData);
      setInterview(iRes.data);

      // ── Restore State if exists ──
      if (cData?.session_state && Object.keys(cData.session_state).length > 0) {
        const state = cData.session_state;
        if (state.transcript) {
          transcriptRef.current = state.transcript;
          setTranscript([...state.transcript]);
        }
        if (state.questionIndex !== undefined) questionIndex.current = state.questionIndex;
        if (state.candidateAnswers) candidateAnswers.current = state.candidateAnswers;
        if (state.coveragePerQuestion) coveragePerQuestion.current = state.coveragePerQuestion;
        if (state.questionsWithFollowUps) questionsWithFollowUps.current = state.questionsWithFollowUps;
        if (state.followUpCountForCurrentQ) followUpCountForCurrentQ.current = state.followUpCountForCurrentQ;

        // NEW: Load Session Count on Resume (don't increment yet)
        sessionCountRef.current = state.sessionCount || 1;

        // Reset segment index for the new session
        segmentIndexRef.current = 1;

        isResumingRef.current = true;
        sendLogToCmd('INFO', `Interview state restored. Pending Resume from Session: ${sessionCountRef.current}`);
      }

      try {
        const ms = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setStream(ms);
        streamRef.current = ms;
        if (videoRef.current) videoRef.current.srcObject = ms;
        sendLogToCmd('INFO', 'User granted Camera/Mic access.');
      } catch (err) {
        sendLogToCmd('ERROR', 'Camera access failed', { error: String(err) });
      }
    };
    init();

    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRec) {
      recognitionRef.current = new SpeechRec();
      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;

      recognitionRef.current.onresult = (event: any) => {
        let finalTrans = '';
        let interimTrans = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) finalTrans += event.results[i][0].transcript;
          else interimTrans += event.results[i][0].transcript;
        }
        if (finalTrans) finalizedTextRef.current += ' ' + finalTrans;
        setCurrentAnswer((finalizedTextRef.current + ' ' + interimTrans).trim());
      };

      // ── Auto-restart on silence / browser timeout ────────────────────
      // The Web Speech API fires 'onend' after ~5-10s of silence even with
      // continuous:true. We restart it transparently so long pauses don't
      // break the session. We only restart when isListeningRef says we
      // should still be listening (i.e. candidate hasn't pressed Submit).
      recognitionRef.current.onend = () => {
        if (isListeningRef.current) {
          try { recognitionRef.current?.start(); } catch (e) { }
        }
      };
    }

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      selectedVoiceRef.current =
        voices.find(v => v.name.includes('Microsoft Ava Online')) ||
        voices.find(v => v.name.includes('Google UK English Male')) ||
        voices.find(v => v.name.includes('Google UK English Female')) ||
        voices.find(v => v.name.includes('Google US English')) ||
        voices.find(v => v.name.includes('Microsoft Neerja Online')) ||
        voices.find(v => v.name.includes('Microsoft Andrew Online')) ||
        voices.find(v => v.name.includes('Microsoft Emma Online')) ||
        voices.find(v => v.name.includes('Natural')) ||
        voices.find(v => v.name.includes('Microsoft Zira')) ||
        voices.find(v => v.name.includes('Microsoft David')) ||
        voices.find(v => v.lang === 'en-US' && /female|zira|samantha/i.test(v.name)) ||
        voices.find(v => v.lang === 'en-GB') ||
        voices.find(v => v.lang === 'en-US') ||
        voices[0] ||
        null;
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
      stream?.getTracks().forEach(t => t.stop());
      try { recognitionRef.current?.stop(); } catch (e) { }
      try { window.speechSynthesis.cancel(); } catch (e) { }
    };
  }, []);

  const splitIntoChunks = (text: string): string[] => {
    return text
      .replace(/\s+/g, ' ')
      .trim()
      .match(/[^.!?]+[.!?]*|.+$/g) || [];
  };

  const preprocessText = (text: string): string => {
    return text
      .replace(/\s+/g, ' ')
      .replace(/:\s*/g, ', ')
      .replace(/;\s*/g, ', ')
      .replace(/\(\s*/g, ', ')
      .replace(/\s*\)/g, ', ')
      .trim();
  };

  const getSentenceStyle = (sentence: string, index: number, total: number) => {
    let rate = 0.98;
    let pitch = 1.02;
    const s = sentence.trim();
    if (s.endsWith('?')) { rate = 1.0; pitch = 1.08; }
    else if (s.endsWith('!')) { rate = 1.03; pitch = 1.1; }
    else if (s.length > 120) { rate = 0.95; pitch = 1.0; }
    if (index === total - 1) { rate -= 0.01; }
    return { rate, pitch };
  };

  const speakChunk = (sentence: string, index: number, total: number) => {
    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(sentence);
      const style = getSentenceStyle(sentence, index, total);
      utterance.voice = selectedVoiceRef.current;
      utterance.rate = style.rate;
      utterance.pitch = style.pitch;
      utterance.volume = 1;
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    });
  };

  const speak = async (text: string) => {
    window.speechSynthesis.cancel();
    if (!selectedVoiceRef.current) {
      const voices = window.speechSynthesis.getVoices();
      selectedVoiceRef.current =
        voices.find(v => v.name.includes('Microsoft Ava Online')) ||
        voices.find(v => v.name.includes('Google UK English Male')) ||
        voices.find(v => v.name.includes('Google UK English Female')) ||
        voices.find(v => v.name.includes('Google US English')) ||
        voices.find(v => v.name.includes('Microsoft Neerja Online')) ||
        voices.find(v => v.name.includes('Microsoft Andrew Online')) ||
        voices.find(v => v.name.includes('Microsoft Emma Online')) ||
        voices.find(v => v.name.includes('Natural')) ||
        voices.find(v => v.name.includes('Microsoft Zira')) ||
        voices.find(v => v.name.includes('Microsoft David')) ||
        voices.find(v => v.lang === 'en-US' && /female|zira|samantha/i.test(v.name)) ||
        voices.find(v => v.lang === 'en-GB') ||
        voices.find(v => v.lang === 'en-US') ||
        voices[0] ||
        null;
    }
    const processed = preprocessText(text);
    if (!processed) return;
    const chunks = splitIntoChunks(processed);
    for (let i = 0; i < chunks.length; i++) {
      await speakChunk(chunks[i].trim(), i, chunks.length);
    }
  };

  // ── Client-side output sanitization ──────────────────────────────
  const sanitizeAIOutput = (text: string | undefined | null): string => {
    if (!text || typeof text !== 'string') {
      return 'I apologize, there was an issue connecting to the AI interviewer. Please try again.';
    }
    return text
      .replace(/\[INTERVIEW_ENDED\]/g, '')
      .replace(/^AI:\s*/i, '')
      .replace(/System\s*Instructions?:[\s\S]{0,200}/gi, '')
      .replace(/\[Interview\s*Questions[\s\S]{0,50}\]/gi, '')
      .trim();
  };

  // ── Get follow_up_depth for current question ─────────────────────
  const getFollowUpDepth = (qIndex: number): number => {
    if (!interview?.question_bank || qIndex < 0 || qIndex >= interview.question_bank.length) return 2;
    return interview.question_bank[qIndex]?.follow_up_depth ?? 2;
  };

  // ── Get key points for a question (from question bank) ───────────
  const getKeyPointsForQuestion = (qIndex: number): string[] => {
    if (!interview?.question_bank || qIndex < 0 || qIndex >= interview.question_bank.length) {
      return [];
    }
    const q = interview.question_bank[qIndex];
    return Array.isArray(q.key_points) ? q.key_points : [];
  };

  // ── Session Orchestrator (Central Controller) ───────────────────────
  const orchestrateSession = async (action: 'start' | 'loop' | 'end', params: any) => {
    try {
      const res = await fetch(`/api/session/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error(`Session ${action} failed: ${res.statusText}`);
      return await res.json();
    } catch (e) {
      sendLogToCmd('ERROR', `[Orchestrator] ${action} failed`, { error: String(e) });
      return { error: String(e) };
    }
  };

  const startListening = () => {
    setCurrentAnswer('');
    finalizedTextRef.current = '';
    if (recognitionRef.current) {
      try {
        isListeningRef.current = true;
        setIsListening(true);
        recognitionRef.current.start();
      } catch (e) { }
    }
  };

  // ── Submit answer → Evaluator 1 decides next step ────────────────
  const submitAnswer = async () => {
    if (recognitionRef.current) {
      isListeningRef.current = false; // prevent onend from restarting
      setIsListening(false);
      recognitionRef.current.stop();
    }

    const finalAnswerText = currentAnswer.trim();

    if (!finalAnswerText) {
      if (emptyAudioAttempts.current < 2) {
        emptyAudioAttempts.current += 1;
        const msg = "I'm sorry, I couldn't hear your response. Could you please check your microphone and try again?";
        const aiMsg = { speaker: 'AI' as 'AI', text: msg };
        transcriptRef.current.push(aiMsg);
        setTranscript([...transcriptRef.current]);
        await speak(msg);
        startListening();
        return;
      } else {
        emptyAudioAttempts.current = 0;
        const moveOnMsg = "It seems we are having audio issues from your side. Let me log that, and we'll move on to the next question.";
        const aiMsg = { speaker: 'AI' as 'AI', text: moveOnMsg };
        transcriptRef.current.push(aiMsg);
        setTranscript([...transcriptRef.current]);
        await speak(moveOnMsg);
      }
    } else {
      emptyAudioAttempts.current = 0;
    }

    const finalAnswer = finalAnswerText || '(No response audible)';

    // Add to transcript locally
    const candidateMsg = { speaker: 'Candidate' as 'Candidate', text: finalAnswer };
    transcriptRef.current.push(candidateMsg);
    setTranscript([...transcriptRef.current]);

    // ── Call Orchestrator Loop ─────────────────────────────────────
    setSavingStatus('Agent is processing your answer...');
    const data = await orchestrateSession('loop', { candidateId: candidate.id, message: finalAnswer });
    
    if (data.response) {
      const cleaned = sanitizeAIOutput(data.response);
      transcriptRef.current.push({ speaker: 'AI', text: cleaned });
      setTranscript([...transcriptRef.current]);
      
      if (data.isCompleted) {
        setIsCompleted(true);
        await speak(cleaned);
        await handleEndInterview();
      } else {
        await speak(cleaned);
        startListening();
      }
    } else {
      // HANDLE ERROR / SILENCE
      const errorMsg = data.error || "I'm having trouble connecting to my brain right now. One moment...";
      const aiMsg = { speaker: 'AI' as const, text: errorMsg };
      transcriptRef.current.push(aiMsg);
      setTranscript([...transcriptRef.current]);
      await speak(errorMsg);
      // Don't auto-restart listening on error to prevent infinite error loops
      setSavingStatus('');
    }
  };

  const handleShowInstructions = () => {
    setShowInstructions(true);
  };

  const processUploadQueue = async () => {
    if (isProcessingQueueRef.current || uploadQueueRef.current.length === 0) return;
    isProcessingQueueRef.current = true;

    while (uploadQueueRef.current.length > 0) {
      const item = uploadQueueRef.current.shift();
      if (!item) continue;

      const { blob, fileName, index } = item;
      const uploadPromise = (async () => {
        try {
          const res = await fetch('/api/upload-video', {
            method: 'POST',
            body: JSON.stringify({ action: 'upload', fileName, fileType: 'video/webm' }),
          });
          const { signedUrl } = await res.json();

          await fetch(signedUrl, {
            method: 'PUT',
            headers: {
              'Content-Type': 'video/webm',
            },
            body: blob,
          });

          // Track segment in DB in the background
          const { data: cData } = await supabase.from('candidates').select('s3_uploaded_parts, session_state').eq('id', candidate.id).single();
          const existing = cData?.s3_uploaded_parts || [];
          const currentState = cData?.session_state || {};

          await supabase.from('candidates').update({
            s3_uploaded_parts: [...existing, { segment: fileName }],
            // Immediate update of session state index for robustness
            session_state: { ...currentState, segmentIndex: index, sessionCount: sessionCountRef.current }
          }).eq('id', candidate.id);

        } catch (err) {
          sendLogToCmd('ERROR', `Background upload failed for segment ${index}`, { error: String(err) });
        }
      })();

      pendingUploadsRef.current.add(uploadPromise);
      await uploadPromise;
      pendingUploadsRef.current.delete(uploadPromise);
    }

    isProcessingQueueRef.current = false;
  };

  const startInterviewProcess = async () => {
    setShowInstructions(false);
    setIsStarted(true);
    isInterviewActive.current = true;
    // Enter fullscreen when interview starts
    enterFullscreen();

    if (stream) {
      const mr = new MediaRecorder(stream, { mimeType: 'video/webm' });
      mr.ondataavailable = (e: any) => {
        if (e.data.size > 0) {
          const blob = e.data;
          const currentIdx = segmentIndexRef.current++;
          const sessionPrefix = `S${String(sessionCountRef.current).padStart(2, '0')}`;
          const segmentFileName = `${candidate.id}/${sessionPrefix}_seg_${String(currentIdx).padStart(4, '0')}.webm`;

          uploadQueueRef.current.push({ blob, fileName: segmentFileName, index: currentIdx });
          processUploadQueue();
        }
      };
      mr.start(5000); // 5 second continuous fragments (produces only one header in first chunk)
      mediaRecorderRef.current = mr;
    }

    if (isResumingRef.current) {
      // Resume logic simplified: Orchestrator handles the state retrieval
      const data = await orchestrateSession('start', { candidateId: candidate.id });
      if (data.success && data.sessionState) {
        const remoteTranscript = data.sessionState.transcript || [];
        setTranscript(remoteTranscript);
        transcriptRef.current = remoteTranscript;
        
        const lastMsg = remoteTranscript.length > 0 ? remoteTranscript[remoteTranscript.length - 1] : null;
        if (lastMsg && lastMsg.speaker === 'AI') {
          await speak(lastMsg.text);
          startListening();
        } else {
          // If candidate was last or just started, trigger loop with empty message
          const loopData = await orchestrateSession('loop', { candidateId: candidate.id, message: '' });
          if (loopData?.response) {
            const cleaned = sanitizeAIOutput(loopData.response);
            const aiMsg = { speaker: 'AI' as const, text: cleaned };
            transcriptRef.current.push(aiMsg);
            setTranscript([...transcriptRef.current]);
            await speak(cleaned);
            startListening();
          } else {
            console.error('[Start] Initial loop failed', loopData);
          }
        }
      }
      isResumingRef.current = false;
    } else {
      // New session start
      const data = await orchestrateSession('start', { candidateId: candidate.id });
      if (data.success) {
        const loopData = await orchestrateSession('loop', { candidateId: candidate.id, message: '' });
        if (loopData?.response) {
          const cleaned = sanitizeAIOutput(loopData.response);
          const aiMsg = { speaker: 'AI' as const, text: cleaned };
          transcriptRef.current.push(aiMsg);
          setTranscript([...transcriptRef.current]);
          await speak(cleaned);
          startListening();
        } else {
          console.error('[Start] Initial loop failed for new session', loopData);
        }
      }
    }
  };

  const handleEndInterview = async () => {
    isInterviewActive.current = false;
    setSavingStatus('Finalizing your interview and saving signals...');
    try { recognitionRef.current?.stop(); } catch (e) { }

    // 1. Stop recording and wait for final chunk
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      await new Promise(r => setTimeout(r, 800)); // Wait for final ondataavailable
    }

    // 2. Wait for all pending uploads
    if (pendingUploadsRef.current.size > 0) {
      setSavingStatus('Synchronizing video recording...');
      await Promise.all(Array.from(pendingUploadsRef.current));
    }

    // 3. Call Orchestrator End
    setSavingStatus('AI is finalizing your results...');
    const data = await orchestrateSession('end', { candidateId: candidate.id });
    
    if (data.success) {
      setSavingStatus('Interview completed successfully.');
      sessionStorage.setItem('interview_done', 'true');
      isInterviewActive.current = false;
      streamRef.current?.getTracks().forEach(t => t.stop());

      if (document.exitFullscreen) document.exitFullscreen().catch(() => { });
      window.location.reload();
    } else {
      sendLogToCmd('ERROR', 'Failed to end session via orchestrator', { error: data.error });
      window.location.reload();
    }
  };

  return (
    <div className="h-screen overflow-hidden bg-[#fcfdfd] text-slate-800 flex flex-col font-sans">

      {/* ── Security Warning Toast ─────────────────────────────── */}
      {showWarning && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-3 bg-red-600 text-white px-6 py-3 rounded-2xl shadow-2xl animate-in slide-in-from-top-4 duration-300 text-sm font-semibold">
          <span>{warningMsg}</span>
        </div>
      )}

      {/* ── Tab Switch Violation Toast (separate, non-blocking) ── */}
      {showTabWarning && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-3 bg-amber-500 text-white px-6 py-3 rounded-2xl shadow-2xl animate-in slide-in-from-top-4 duration-300 text-sm font-semibold">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>Tab switch detected — Violation #{tabSwitchCount}</span>
        </div>
      )}

      {/* ── Fullscreen Re-entry Prompt (blocking, auto-enters on any click) */}
      {showFullscreenPrompt && (
        <div
          className="fixed inset-0 z-[99999] bg-slate-900/95 backdrop-blur-md flex flex-col items-center justify-center gap-8 text-center px-8 cursor-pointer"
          onClick={() => enterFullscreen()}
        >
          <div className="w-24 h-24 rounded-3xl bg-red-500/20 border border-red-400/30 flex items-center justify-center mb-2 animate-pulse">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-red-400">
              <path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </div>
          <div className="space-y-3">
            <h2 className="text-3xl font-bold text-white tracking-tight">Fullscreen Required</h2>
            <p className="text-slate-300 text-base max-w-sm leading-relaxed">
              You exited fullscreen. The interview is paused.
            </p>
          </div>
          <div className="bg-blue-600 text-white font-bold px-10 py-4 rounded-2xl text-lg shadow-2xl shadow-blue-900/40 flex items-center gap-3">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
            Click anywhere to return to Fullscreen
          </div>
          <p className="text-slate-600 text-xs">
            Exiting fullscreen during the interview may be flagged as a violation.
          </p>
        </div>
      )}
      <header className="px-6 py-4 flex items-center justify-between border-b border-slate-200 bg-white/70 backdrop-blur-md shrink-0 z-50">
        <div className="flex items-center gap-3">
          <Image src={logoImg} alt="Altimetrik" width={32} height={32} className="w-8 h-8 rounded-lg" />
          <div className="h-6 w-[1px] bg-slate-200 mx-1" />
          <div className="flex items-center gap-2">
            {stream ? <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.5)]" /> : <Video size={16} className="text-slate-400" />}
            <span className="font-bold text-slate-900 tracking-tight">{interview?.title || 'Assessment'}</span>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-100 rounded-xl">
            <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center">
              <User size={14} className="text-blue-600" />
            </div>
            <span className="text-sm font-medium text-slate-600">
              {candidate?.name || 'Candidate'}
            </span>
          </div>

          {supportEmail && (
            <a
              href={`mailto:${supportEmail}`}
              className="flex items-center gap-2 px-4 py-2 bg-white shadow-sm hover:shadow-md border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 transition-all active:scale-95"
            >
              <Mail size={14} className="text-blue-500" />
              <span className="hidden xs:inline">Support</span>
            </a>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row p-6 gap-6 relative overflow-hidden bg-dot-pattern">
        <div className="flex-1 rounded-[2rem] overflow-hidden bg-white shadow-[0_20px_50px_rgba(0,0,0,0.04)] border border-slate-200 relative flex items-center justify-center">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />

          {!isStarted && !showInstructions && (
            <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex items-center justify-center z-20">
              <button
                onClick={handleShowInstructions}
                className="bg-blue-600 hover:bg-blue-700 text-white px-10 py-5 rounded-2xl font-bold text-lg flex items-center gap-3 transition-all shadow-xl hover:shadow-2xl active:scale-95"
              >
                <Play fill="currentColor" size={24} />
                Begin Assessment
              </button>
            </div>
          )}

          {showInstructions && !isStarted && (
            <div className="absolute inset-0 bg-white z-[100] flex items-center justify-center overflow-y-auto p-8">
              <div className="max-w-2xl w-full space-y-8 animate-in fade-in zoom-in duration-300">
                <div className="text-center space-y-3">
                  <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-blue-50 border border-blue-100 mb-2">
                    <BookOpen size={40} className="text-blue-500" />
                  </div>
                  <h2 className="text-4xl font-bold text-slate-900 tracking-tight">Interview Guide</h2>
                  <p className="text-slate-500 text-base">Quick guidelines for a successful session.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    { icon: <Video className="text-blue-500" size={20} />, title: 'Camera Active', desc: 'Your video will be recorded for evaluation.' },
                    { icon: <Mic className="text-emerald-500" size={20} />, title: 'Speak Clearly', desc: 'Wait for the AI to finish, then answer.' },
                    { icon: <CheckCircle2 className="text-blue-500" size={20} />, title: 'Auto-Finish', desc: 'The session ends after all questions.' },
                    { icon: <AlertTriangle className="text-amber-500" size={20} />, title: 'Stay on Page', desc: 'Do not refresh or close the tab.' }
                  ].map((item, i) => (
                    <div key={i} className="p-5 bg-slate-50 border border-slate-100 rounded-2xl flex gap-4">
                      <div className="p-2 bg-white rounded-xl shadow-sm h-fit">{item.icon}</div>
                      <div>
                        <h4 className="font-bold text-slate-800 text-sm mb-1">{item.title}</h4>
                        <p className="text-xs text-slate-500 leading-normal">{item.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bg-blue-50 border border-blue-100 p-6 rounded-[1.5rem] text-sm text-blue-800 text-center leading-relaxed">
                  Ready to start? Ensure you are in a quiet room with a stable internet connection.
                </div>

                <div className="flex justify-center pt-2">
                  <button
                    onClick={startInterviewProcess}
                    className="bg-slate-900 hover:bg-black text-white px-12 py-5 rounded-2xl font-bold text-lg flex items-center gap-3 transition-all shadow-xl hover:shadow-2xl active:scale-95"
                  >
                    Start Now
                    <ArrowRight size={22} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {isCompleted && (
            <div className="absolute inset-0 bg-white/95 backdrop-blur-xl flex flex-col items-center justify-center p-8 text-center z-[100] animate-in fade-in duration-500">
              <div className="w-24 h-24 bg-blue-50 rounded-[2.5rem] flex items-center justify-center mb-8 shadow-inner">
                <ShieldCheck size={48} className="text-blue-600 animate-bounce" />
              </div>

              <h2 className="text-4xl font-bold mb-3 text-slate-900 tracking-tight">
                {isUploadComplete ? 'Assessment Complete!' : 'Finalizing...'}
              </h2>
              <p className={`text-slate-500 text-lg mb-10 max-w-md ${!isUploadComplete ? 'animate-pulse' : ''}`}>
                {savingStatus}
              </p>

              {isUploadComplete && (
                <button
                  onClick={() => {
                    sessionStorage.removeItem('interview_done');
                    streamRef.current?.getTracks().forEach(t => t.stop());
                    try { recognitionRef.current?.stop(); } catch (e) { }
                    router.push('/');
                  }}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-12 py-5 rounded-2xl transition-all shadow-xl active:scale-95"
                >
                  Return to Dashboard
                </button>
              )}
            </div>
          )}

          {isListening && !isCompleted && (
            <div className="absolute bottom-8 left-8 right-8 flex justify-between items-center bg-white/90 backdrop-blur-md px-8 py-5 rounded-[2rem] border border-slate-200 shadow-2xl z-30 animate-in slide-in-from-bottom-4 duration-300">
              <div className="flex items-center gap-4 text-base font-semibold text-slate-800">
                <div className="relative">
                  <Mic size={24} className="text-blue-500 relative z-10" />
                  <div className="absolute inset-0 bg-blue-400 rounded-full animate-ping opacity-20" />
                </div>
                <span>Listening...</span>
              </div>
              <button
                onClick={submitAnswer}
                className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-xl font-bold flex items-center gap-2 transition-all active:scale-95 shadow-lg"
              >
                Submit Answer
              </button>
            </div>
          )}
        </div>

        <div className="w-full lg:w-[400px] flex flex-col bg-white shadow-[0_20px_50px_rgba(0,0,0,0.04)] border border-slate-200 rounded-[2rem] overflow-hidden shrink-0 h-full">
          <div className="p-6 border-b border-slate-100 bg-slate-50/50">
            <h3 className="font-bold text-slate-900 flex items-center gap-2">
              <span className="w-2 h-2 bg-blue-500 rounded-full" />
              Dialogue History
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {(transcript || []).length === 0 && !currentAnswer && (
              <div className="h-full flex flex-col items-center justify-center opacity-30 text-slate-400 p-8">
                <Mic size={40} className="mb-4" />
                <p className="text-sm font-medium">Interview haven't started yet</p>
              </div>
            )}
            {(transcript || []).map((msg, i) => (
              <div key={i} className={`flex flex-col ${msg.speaker === 'Candidate' ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-2 duration-200`}>
                <span className="text-[10px] uppercase font-bold text-slate-400 mb-1.5 px-2 tracking-widest">
                  {msg.speaker === 'AI' ? 'Alti' : (candidate?.name || 'Candidate')}
                </span>
                <div className={`px-5 py-3 rounded-2xl max-w-[90%] text-sm leading-relaxed shadow-sm ${msg.speaker === 'Candidate' ? 'bg-blue-600 text-white rounded-tr-none' : 'bg-slate-100 text-slate-700 rounded-tl-none border border-slate-100'
                  }`}>
                  {msg.text}
                </div>
              </div>
            ))}
            {isListening && currentAnswer && (
              <div className="flex flex-col items-end">
                <span className="text-[10px] uppercase font-bold text-slate-400 mb-1.5 px-2 tracking-widest">{candidate?.name ? `${candidate.name} (Live)` : 'Candidate (Live)'}</span>
                <div className="px-5 py-3 rounded-2xl max-w-[90%] text-sm bg-blue-50 text-blue-700 border border-blue-100 italic">
                  {currentAnswer}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </main>
    </div>
  );
}
