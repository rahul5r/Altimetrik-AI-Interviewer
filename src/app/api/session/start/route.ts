import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { candidateId } = await req.json();

    if (!candidateId) {
      return NextResponse.json({ error: 'Candidate ID is required' }, { status: 400 });
    }

    // 1. Fetch Candidate and Interview Details
    const { data: candidate, error: candidateError } = await supabase
      .from('candidates')
      .select('*, interviews(*)')
      .eq('id', candidateId)
      .single();

    if (candidateError || !candidate) {
      return NextResponse.json({ error: 'Candidate not found' }, { status: 404 });
    }

    if (!candidate.interviews) {
      return NextResponse.json({ error: 'Interview not assigned to candidate' }, { status: 400 });
    }

    // 2. Check for existing session state
    let sessionState = candidate.session_state;
    let isResume = false;

    if (sessionState && Object.keys(sessionState).length > 0 && !sessionState.isCompleted) {
      console.log(`[SessionStart] Resuming existing session for candidate: ${candidateId}`);
      isResume = true;
    } else {
      console.log(`[SessionStart] Starting NEW session for candidate: ${candidateId}`);
      sessionState = {
        transcript: [],
        currentQuestionIndex: null,
        isIntroPhase: true,
        followUpsHistory: {},
        evalMetadata: {},
        isCompleted: false,
        startTime: new Date().toISOString()
      };

      // Initialize session in DB
      await supabase
        .from('candidates')
        .update({ 
          session_state: sessionState,
          session_started_at: new Date().toISOString()
        })
        .eq('id', candidateId);
    }

    return NextResponse.json({
      success: true,
      isResume,
      sessionState,
      interview: candidate.interviews,
      candidate: {
        id: candidate.id,
        name: candidate.name,
        email: candidate.email
      }
    });

  } catch (error: any) {
    console.error('[SessionStart] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
