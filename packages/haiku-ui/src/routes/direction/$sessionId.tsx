/**
 * /direction/:sessionId — pick a design direction from the archetype set.
 */

import { createFileRoute } from "@tanstack/react-router"
import { DirectionModule } from "../../pages"

function DirectionRoute(): React.ReactElement {
	const { sessionId } = Route.useParams()
	return <DirectionModule sessionId={sessionId} />
}

export const Route = createFileRoute("/direction/$sessionId")({
	component: DirectionRoute,
})
