import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { candidateId } = await req.json();

    if (!candidateId) {
      return NextResponse.json({ error: 'Candidate ID is required' }, { status: 400 });
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

    const state = candidate.session_state;
    const interview = candidate.interviews;

    if (!state || !state.isCompleted) {
      console.warn(`[SessionEnd] Caution: Ending a session that isn't marked as completed in state.`);
    }

    // 2. Prepare data for Evaluate
    const per_question_followups = Object.entries(state.followUpsHistory || {}).map(([idx, history]: [string, any]) => ({
      questionIndex: parseInt(idx),
      count: history.length
    }));

    const per_question_coverage = Object.entries(state.evalMetadata || {}).map(([idx, data]: [string, any]) => ({
      questionIndex: parseInt(idx),
      coverage: data.coverage
    }));

    const coverageData = {
      average_coverage: per_question_coverage.length > 0 
        ? per_question_coverage.reduce((acc, curr) => acc + curr.coverage, 0) / per_question_coverage.length 
        : 0,
      per_question: per_question_coverage
    };

    const followUpData = {
      questions_with_follow_ups: per_question_followups.length,
      per_question: per_question_followups,
      total_questions: interview.question_bank.length
    };

    // 3. Call Final Evaluator
    const evalResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questionBank: interview.question_bank,
        previousContext: state.transcript,
        coverageData,
        followUpData
      })
    });

    const evalResult = await evalResponse.json();

    // 4. Save to Results table
    const { data: resultData, error: resultError } = await supabase
      .from('results')
      .insert({
        candidate_id: candidateId,
        interview_id: interview.id,
        evaluation: evalResult.evaluation,
        transcript_data: state.transcript,
        video_url: candidate.video_url || null // If provided elsewhere
      })
      .select()
      .single();

    if (resultError) {
      console.error('[SessionEnd] Error saving result:', resultError);
      return NextResponse.json({ error: 'Failed to save results' }, { status: 500 });
    }

    // 5. Mark candidate session as fully completed
    await supabase
      .from('candidates')
      .update({ 
        session_state: { ...state, isCompleted: true, endResultId: resultData.id } 
      })
      .eq('id', candidateId);

    return NextResponse.json({
      success: true,
      resultId: resultData.id,
      evaluation: evalResult.evaluation
    });

  } catch (error: any) {
    console.error('[SessionEnd] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
