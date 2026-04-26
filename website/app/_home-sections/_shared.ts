// Shared helpers for the per-section files extracted from
// HomeContent.tsx. Each section file imports `fadeIn` for its
// motion components and the `RecentPost` shape when relevant.

export const fadeIn = {
	initial: { opacity: 0, y: 20 },
	whileInView: { opacity: 1, y: 0 },
	viewport: { once: true, margin: "-40px" as const },
	transition: { duration: 0.5 },
}

export interface RecentPost {
	slug: string
	title: string
	description?: string
	date: string
}

export function formatDate(dateString: string): string {
	const date = new Date(dateString)
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	})
}
