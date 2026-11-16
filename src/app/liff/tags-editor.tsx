'use client'

import { useState } from 'react'
import { addTag, removeTag, TAGS_TEXT } from './tags-model'
import { inputClass } from './ui'

/** #109: tags as chips with a remove button, and a field to add one (Enter or the button). */
export function TagsEditor({ tags, onChange, disabled = false }: {
  tags: string[]; onChange: (tags: string[]) => void; disabled?: boolean
}) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const add = () => {
    const r = addTag(tags, input)
    setError(r.error)
    if (r.error === null) {
      if (r.tags !== tags) onChange(r.tags)
      setInput('')
    }
  }
  return (
    <div className="space-y-2">
      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <li key={t} className="inline-flex items-center gap-1 rounded-full bg-primary-soft py-0.5 pl-2.5 pr-1 text-xs font-semibold text-primary">
              {t}
              <button type="button" aria-label={TAGS_TEXT.remove(t)} disabled={disabled}
                className="flex h-5 w-5 items-center justify-center rounded-full text-primary disabled:opacity-50"
                onClick={() => onChange(removeTag(tags, t))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input type="text" className={inputClass} value={input} disabled={disabled} placeholder={TAGS_TEXT.placeholder}
          aria-label={TAGS_TEXT.label}
          onChange={(e) => { setInput(e.target.value); setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
        <button type="button" disabled={disabled || input.trim() === ''} onClick={add}
          className="shrink-0 rounded-xl border border-line-strong px-4 text-sm font-semibold text-ink disabled:opacity-50">
          {TAGS_TEXT.add}
        </button>
      </div>
      <p className={`text-xs ${error ? 'text-danger' : 'text-ink-3'}`}>{error ?? TAGS_TEXT.hint}</p>
    </div>
  )
}
