interface Props {
  value: string
  onChange: (text: string) => void
}

export function PieceNotes({ value, onChange }: Props) {
  return (
    <div className="piece-notes card">
      <h2>Practice notes</h2>
      <p className="hint">Saved on this device for the selected piece (teacher tips, weekly goals).</p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        placeholder="e.g. Focus on even LH in the opening phrase…"
      />
    </div>
  )
}
