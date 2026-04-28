"use client"

import { type ReactNode, useEffect } from "react"

interface ModalProps {
	open: boolean
	title: string
	subtitle?: string
	children: ReactNode
	onClose: () => void
}

export function Modal({ open, title, subtitle, children, onClose }: ModalProps) {
	useEffect(() => {
		if (!open) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose()
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [open, onClose])

	return (
		<div
			className={`modal-backdrop${open ? " open" : ""}`}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose()
			}}
			onKeyDown={() => {}}
			aria-hidden={!open}
		>
			<div className="modal" role="dialog" aria-modal="true" aria-label={title}>
				<div className="modal-header">
					<div>
						<div className="modal-title">{title}</div>
						{subtitle ? <div className="modal-stage">{subtitle}</div> : null}
					</div>
					<button type="button" className="modal-close" onClick={onClose}>
						close · esc
					</button>
				</div>
				<div className="modal-body">{children}</div>
			</div>
		</div>
	)
}

/** Wrap renderInline / renderMarkdown HTML strings so the modal can use them as JSX. */
export function HtmlBlock({
	html,
	className,
	style,
}: {
	html: string
	className?: string
	style?: React.CSSProperties
}) {
	// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted prototype copy
	return <div className={className} style={style} dangerouslySetInnerHTML={{ __html: html }} />
}
