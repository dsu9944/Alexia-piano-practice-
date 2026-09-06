interface Props {
  value: number | undefined
  onChange: (stars: number) => void
  disabled?: boolean
  label?: string
  size?: 'sm' | 'md'
}

/** Tap 1–5 stars. Joe rates after listening. */
export function StarRating({
  value,
  onChange,
  disabled = false,
  label = 'Stars',
  size = 'md',
}: Props) {
  const stars = value && value >= 1 && value <= 5 ? value : 0
  return (
    <div className={`star-rating star-rating-${size}${disabled ? ' is-disabled' : ''}`}>
      <span className="star-rating-label">{label}</span>
      <div className="star-rating-row" role="group" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = n <= stars
          return (
            <button
              key={n}
              type="button"
              className={`star-btn${filled ? ' is-filled' : ''}`}
              disabled={disabled}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              aria-pressed={filled}
              onClick={() => {
                // Tap same star again to clear
                if (stars === n) onChange(0)
                else onChange(n)
              }}
            >
              {filled ? '★' : '☆'}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Read-only star display for progress history. */
export function StarDisplay({ value, size = 'sm' }: { value: number | undefined; size?: 'sm' | 'md' }) {
  const stars = value && value >= 1 && value <= 5 ? value : 0
  return (
    <span className={`star-display star-display-${size}`} aria-label={stars ? `${stars} stars` : 'No stars yet'}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= stars ? 'is-filled' : ''}>
          {n <= stars ? '★' : '☆'}
        </span>
      ))}
    </span>
  )
}
