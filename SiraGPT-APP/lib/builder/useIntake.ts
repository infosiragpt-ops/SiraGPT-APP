"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  intakeService,
  type AnswerValue,
  type Blueprint,
  type Coverage,
  type CoverageDimension,
  type IntakeSession,
  type ProjectBrief,
  type QuestionCard,
  type ScaffoldFile,
} from "./intake-service"

export const DIMENSION_ORDER: CoverageDimension[] = [
  "purpose",
  "platform",
  "coreFeatures",
  "dataEntities",
  "style",
  "audience",
]

export interface TranscriptEntry {
  card: QuestionCard
  value: AnswerValue
}

export interface BuildResult {
  brief: ProjectBrief
  blueprint: Blueprint
  files: ScaffoldFile[]
}

export type IntakePhase = "loading" | "intake" | "generating" | "result"

const EMPTY_SESSION: IntakeSession = { answers: {}, integrations: [], constraints: "" }

/**
 * Drives a single Builder intake session. The component owns one instance.
 * Server is stateless: we hold the `session` and resend it each step.
 */
export function useIntake() {
  const [phase, setPhase] = useState<IntakePhase>("loading")
  const [session, setSession] = useState<IntakeSession>(EMPTY_SESSION)
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [question, setQuestion] = useState<QuestionCard | null>(null)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [integrations, setIntegrations] = useState<string[]>([])
  const [constraints, setConstraints] = useState("")
  const [result, setResult] = useState<BuildResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const started = useRef(false)

  const init = useCallback(async () => {
    setError(null)
    setPhase("loading")
    try {
      const snap = await intakeService.step({})
      setSession(snap.session)
      setCoverage(snap.coverage)
      setQuestion(snap.nextQuestion)
      setPhase("intake")
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar el intake")
      setPhase("intake")
    }
  }, [])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void init()
  }, [init])

  /** Answer the current question and advance. */
  const submit = useCallback(
    async (card: QuestionCard, value: AnswerValue) => {
      setBusy(true)
      setError(null)
      try {
        const snap = await intakeService.step({
          session,
          answer: { dimension: card.dimension, value },
        })
        setSession(snap.session)
        setCoverage(snap.coverage)
        setQuestion(snap.nextQuestion)
        setTranscript((prev) => {
          // Replace an earlier answer to the same dimension if re-answered.
          const without = prev.filter((e) => e.card.dimension !== card.dimension)
          return [...without, { card, value }]
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo registrar la respuesta")
      } finally {
        setBusy(false)
      }
    },
    [session],
  )

  /** Build the brief + blueprint + starter files once coverage is complete. */
  const generate = useCallback(async () => {
    setBusy(true)
    setError(null)
    setPhase("generating")
    try {
      const fullSession: IntakeSession = { ...session, integrations, constraints }
      const brief = await intakeService.brief(fullSession)
      const scaffold = await intakeService.scaffold(brief)
      setResult({ brief, blueprint: scaffold.blueprint, files: scaffold.files })
      setPhase("result")
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el proyecto")
      setPhase("intake")
    } finally {
      setBusy(false)
    }
  }, [session, integrations, constraints])

  const reset = useCallback(() => {
    setSession(EMPTY_SESSION)
    setCoverage(null)
    setQuestion(null)
    setTranscript([])
    setIntegrations([])
    setConstraints("")
    setResult(null)
    setError(null)
    started.current = false
    void init()
  }, [init])

  return {
    phase,
    coverage,
    question,
    transcript,
    integrations,
    constraints,
    result,
    busy,
    error,
    setIntegrations,
    setConstraints,
    submit,
    generate,
    reset,
  }
}
