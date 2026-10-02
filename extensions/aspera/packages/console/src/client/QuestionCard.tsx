/** Durable operator decisions use the original question revision for every retry. */
import { useRef, useState } from 'react'
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ExperimentQuestion } from '@aspera/experiments/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExperimentsController } from './controller.ts'
import css from './ExperimentsPage.module.css'

/** Present a saved question without changing its pending status on open.
 * @param props - original question, evidence and reply action. @returns operator question card.
 */
export function ExperimentQuestionCard({ controller, question, records, t }: {
  controller: ExperimentsController; question: ExperimentQuestion; records: string; t: TranslateNS<'experiments'>
}) {
  const [answers, setAnswers] = useState(question.questions.map(item => ({ id: item.id, selected: [] as string[], custom: '' })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const pending = useRef(false)
  const submit = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(undefined)
    try {
      await controller.answer(question.experimentId, { questionId: question.questionId, revision: question.revision,
        sessionId: question.sessionId, callId: question.callId,
        answer: { answers: answers.map(item => ({ id: item.id, selected: item.selected, ...(item.custom.trim() === '' ? {} : { custom: item.custom.trim() }) })) } })
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <section className={`${css.card} ${css.question}`} aria-label={t('operatorQuestion')}>
    <div className={css.cardHeading}><h3>{t('operatorQuestion')}</h3><span className={css.count}>{t('waiting-reply')}</span></div>
    <p className={css.hint}>{t('questionPauseHint')}</p>
    {question.questions.map((item, index) => <fieldset key={item.id} disabled={busy}>
      <legend>{item.header ?? item.question}</legend>{item.header !== undefined && <p>{item.question}</p>}
      {item.detail !== undefined && <p className={css.questionDetail}>{item.detail}</p>}
      {item.options?.map(option => <label key={option.label} className={css.option}>
        <Checkbox label={option.label} checked={answers[index]!.selected.includes(option.label)} onChange={checked => {
          setAnswers(current => current.map((answer, i) => i !== index ? answer : { ...answer,
            selected: checked ? item.multiSelect ? [...answer.selected, option.label] : [option.label] : answer.selected.filter(label => label !== option.label) }))
        }} />{option.description !== undefined && <small className={css.hint}>{option.description}</small>}
      </label>)}
      <label className={css.field}>{t('textReply')}<textarea rows={3} value={answers[index]!.custom} onChange={event => {
        setAnswers(current => current.map((answer, i) => i !== index ? answer : { ...answer, custom: event.target.value }))
      }} /></label>
    </fieldset>)}
    <details><summary>{t('relatedRecords')}</summary><dl className={css.facts}><dt>{t('executionSession')}</dt><dd>{question.sessionId}</dd><dt>{t('toolCall')}</dt><dd>{question.callId}</dd></dl><pre className={css.log}>{records || t('noOutput')}</pre></details>
    <p className={css.hint}>{t('replyConstraintHint')}</p>
    {error !== undefined && <p role="alert" className={css.error}>{error}</p>}
    <div className={css.actions}><Button variant="primary" disabled={busy || answers.some(item => item.selected.length === 0 && item.custom.trim() === '')} onClick={() => { void submit() }}>{busy ? t('busy') : t('replyAndContinue')}</Button></div>
  </section>
}
