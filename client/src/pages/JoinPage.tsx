import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, ROLE_LABEL } from '../api'
import { Spinner } from '../components/common'

/** /join/:token - accept a share link, then open the document. */
export function JoinPage() {
  const { token } = useParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const preview = await api.previewShare(token!)
        const res = await api.acceptShare(token!)
        if (cancelled) return
        navigate(`/d/${res.documentId}`, {
          replace: true,
          state: { joined: `You joined "${preview.document.title}" (${ROLE_LABEL[res.role].toLowerCase()})` },
        })
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, navigate])

  if (!error) return <Spinner label="Opening shared document…" />
  return (
    <div className="center-screen">
      <h1>Can't open this link</h1>
      <p className="muted">{error}</p>
      <Link className="btn" to="/">
        Go to my documents
      </Link>
    </div>
  )
}
