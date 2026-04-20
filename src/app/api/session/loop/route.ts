import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { candidateId, message } = await req.json();

    if (!candidateId || message === undefined) {
      return NextResponse.json({ error: 'Candidate ID and message are required' }, { status: 400 });
    }

    // 1. Fetch Session State
    const { data: candidate, error: candidateError } = await supabase
      .from('candidates')
      .select('*, interviews(*)')
      .eq('id', candidateId)
      .single();

    if (candidateError || !candidate) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    let state = candidate.session_state;
    const interview = candidate.interviews;
    const questionBank = interview.question_bank;

    // Safety: Ensure state is initialized
    if (!state || typeof state !== 'object') {
      state = {
        transcript: [],
        currentQuestionIndex: null,
        isIntroPhase: true,
        followUpsHistory: {},
        evalMetadata: {},
        isCompleted: false
      };
    }
    if (!Array.isArray(state.transcript)) {
      state.transcript = [];
    }

    // 2. Append Candidate Message to Transcript
    if (message) {
      state.transcript.push({
        speaker: 'Candidate',
        text: message,
        timestamp: new Date().toISOString()
      });
    }

    let interviewerPayload: any = {
      action: 'ask_next',
      questionBank,
      transcript: state.transcript,
      candidateName: candidate.name,
      currentQuestionIndex: state.currentQuestionIndex,
      isIntroPhase: state.isIntroPhase
    };

    const internalAppUrl = process.env.NEXT_PUBLIC_APP_URL?.replace('localhost', '127.0.0.1') || 'http://127.0.0.1:3000';

    // 3. Logic based on Phase
    if (!state.isIntroPhase && state.currentQuestionIndex !== null) {
      console.log(`[SessionLoop] Technical Phase: Evaluating Q${state.currentQuestionIndex}`);
      
      const rawQuestion = questionBank[state.currentQuestionIndex];
      const questionText = typeof rawQuestion === 'string' ? rawQuestion : (rawQuestion.question || rawQuestion.text || '');
      const keyPoints = Array.isArray(rawQuestion.key_points) ? rawQuestion.key_points : (rawQuestion.keyPoints || []);
      
      const followUpsForThisQ = state.followUpsHistory[state.currentQuestionIndex] || [];

      // Call Live Evaluator
      console.log(`[SessionLoop] Calling Live Evaluator at ${internalAppUrl}/api/live-evaluate`);
      
      const evalResponse = await fetch(`${internalAppUrl}/api/live-evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: questionText,
          candidateAnswer: message,
          keyPoints: keyPoints,
          followUpsHistory: followUpsForThisQ,
          allQuestions: questionBank.map((q: any) => typeof q === 'string' ? q : (q.question || q.text || '')),
          maxFollowUps: 2,
          currentFollowUpCount: followUpsForThisQ.length
        })
      });

      if (!evalResponse.ok) {
        console.error(`[SessionLoop] Evaluator failed with status: ${evalResponse.status}`);
        throw new Error('Live evaluator failed to respond');
      }

      const evaluation = await evalResponse.json();
      console.log(`[SessionLoop] Evaluation Decision: ${evaluation.decision}`);

      // Record evaluation metadata
      if (!state.evalMetadata) state.evalMetadata = {};
      state.evalMetadata[state.currentQuestionIndex] = {
        coverage: evaluation.coverage_percentage,
        coveredPoints: evaluation.covered_points
      };

      if (evaluation.decision === 'follow_up') {
        followUpsForThisQ.push({ q: evaluation.follow_up_question, a: '' });
        state.followUpsHistory[state.currentQuestionIndex] = followUpsForThisQ;
        interviewerPayload.followUpInstruction = evaluation.follow_up_question;
      } else {
        state.currentQuestionIndex++;
        if (state.currentQuestionIndex >= questionBank.length) {
          interviewerPayload.isCompleted = true;
        }
      }
    }

    // 4. Call Interviewer to get the next AI response
    console.log(`[SessionLoop] Calling Interviewer at ${internalAppUrl}/api/interviewer`);
    
    const intResponse = await fetch(`${internalAppUrl}/api/interviewer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(interviewerPayload)
    });

    if (!intResponse.ok) {
      console.error(`[SessionLoop] Interviewer failed with status: ${intResponse.status}`);
      throw new Error('Interviewer failed to respond');
    }

    const interviewerResult = await intResponse.json();
    console.log(`[SessionLoop] Interviewer Responded: ${interviewerResult.response?.substring(0, 50)}...`);

    if (!interviewerResult || !interviewerResult.response) {
      throw new Error('Interviewer failed to respond');
    }

    // 5. Update State
    state.transcript.push({
      speaker: 'AI',
      text: interviewerResult.response,
      timestamp: new Date().toISOString()
    });

    if (state.isIntroPhase && interviewerResult.currentQuestionIndex !== null) {
      state.isIntroPhase = false;
      state.currentQuestionIndex = 0;
    }

    if (interviewerResult.isCompleted) {
      state.isCompleted = true;
    }

    // 6. Save State to DB
    await supabase
      .from('candidates')
      .update({ session_state: state })
      .eq('id', candidateId);

    return NextResponse.json({
      response: interviewerResult.response,
      isCompleted: state.isCompleted,
      state: state
    });

  } catch (error: any) {
    console.error('[SessionLoop] Orchestration Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
