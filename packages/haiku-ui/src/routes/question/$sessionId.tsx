/**
 * /question/:sessionId — answer a pending question.
 *
 * The QuestionModule owns its own shell (SessionShell) so it can render
 * the session's title in the branded header. Routes are now thin.
 */

import { createFileRoute } from "@tanstack/react-router"
import { QuestionModule } from "../../pages"

function QuestionRoute(): React.ReactElement {
	const { sessionId } = Route.useParams()
	return <QuestionModule sessionId={sessionId} />
}

export const Route = createFileRoute("/question/$sessionId")({
	component: QuestionRoute,
})
