interface Props {
  youtubeId: string
  title: string
}

export function YouTubePlayer({ youtubeId, title }: Props) {
  return (
    <div className="youtube-wrap">
      <h2>Listening reference</h2>
      <p className="hint">Play along with the YouTube recording. Audio stays on YouTube — nothing is downloaded.</p>
      <div className="video-frame">
        <iframe
          title={`YouTube: ${title}`}
          src={`https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    </div>
  )
}
