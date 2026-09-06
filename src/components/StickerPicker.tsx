import { useState } from 'react'
import { STICKERS, stickerById } from '../data/stickers'

interface Props {
  selected: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  compact?: boolean
  title?: string
}

/** Earned sticker chips (read + optional remove). */
export function StickerChips({
  ids,
  onRemove,
  emptyLabel,
}: {
  ids: string[]
  onRemove?: (id: string) => void
  emptyLabel?: string
}) {
  if (!ids.length) {
    return emptyLabel ? <span className="sticker-empty">{emptyLabel}</span> : null
  }
  return (
    <div className="sticker-chips">
      {ids.map((id) => {
        const def = stickerById(id)
        if (!def) return null
        return (
          <span
            key={id}
            className="sticker-chip"
            style={{ background: def.tint }}
            title={def.label}
          >
            <span className="sticker-emoji" aria-hidden>
              {def.emoji}
            </span>
            <span className="sticker-chip-label">{def.label}</span>
            {onRemove && (
              <button
                type="button"
                className="sticker-chip-remove"
                aria-label={`Remove ${def.label}`}
                onClick={() => onRemove(id)}
              >
                ×
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

/** Teacher sticker picker — colourful chips, not scary. */
export function StickerPicker({
  selected,
  onChange,
  disabled = false,
  compact = false,
  title = 'Stickers',
}: Props) {
  const [open, setOpen] = useState(false)
  const selectedSet = new Set(selected)

  const toggle = (id: string) => {
    if (disabled) return
    if (selectedSet.has(id)) {
      onChange(selected.filter((x) => x !== id))
    } else {
      onChange([...selected, id])
    }
  }

  return (
    <div className={`sticker-picker${compact ? ' is-compact' : ''}${disabled ? ' is-disabled' : ''}`}>
      <div className="sticker-picker-head">
        <span className="sticker-picker-title">{title}</span>
        <button
          type="button"
          className="btn micro ghost"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? 'Done' : '+ Add'}
        </button>
      </div>
      <StickerChips
        ids={selected}
        onRemove={
          disabled
            ? undefined
            : (id) => onChange(selected.filter((x) => x !== id))
        }
        emptyLabel={open ? undefined : 'None yet'}
      />
      {open && !disabled && (
        <div className="sticker-palette" role="listbox" aria-label="Choose stickers">
          {STICKERS.map((s) => {
            const on = selectedSet.has(s.id)
            return (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={on}
                className={`sticker-option${on ? ' is-on' : ''}`}
                style={{ background: s.tint }}
                onClick={() => toggle(s.id)}
              >
                <span className="sticker-emoji" aria-hidden>
                  {s.emoji}
                </span>
                <span>{s.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
