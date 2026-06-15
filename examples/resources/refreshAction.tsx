import * as React from 'react';

import * as Reactodia from '../../src/workspace';

export function ToolbarActionRefresh(props: {
    baseUrl: string;
}) {
    const {baseUrl} = props;
    const {model} = Reactodia.useWorkspace();
    return (
        <Reactodia.ToolbarAction
            onSelect={async () => {
                const diagram = model.exportLayout();
                const dataProvider = new Reactodia.HttpApiDataProvider({baseUrl});

                // Pre-fetch to identify missing elements before import overwrites state
                const allIris = model.elements.flatMap(el =>
                    [...Reactodia.iterateEntitiesOf(el)].map(e => e.id as Reactodia.ElementIri)
                );
                const preloadedElements = allIris.length > 0
                    ? await dataProvider.elements({elementIds: allIris})
                    : new Map<Reactodia.ElementIri, Reactodia.ElementModel>();
                const missingIris = new Set(allIris.filter(iri => !preloadedElements.has(iri)));

                await model.importLayout({dataProvider, diagram, validateLinks: true, preloadedElements});

                // Clear selection before removal to avoid ghost selection boxes
                model.setSelection([]);

                // Remove elements no longer in the data source
                for (const el of [...model.elements]) {
                    for (const entity of Reactodia.iterateEntitiesOf(el)) {
                        if (missingIris.has(entity.id as Reactodia.ElementIri)) {
                            model.removeElement(el.id);
                            break;
                        }
                    }
                }

                // Remove links not confirmed by the server (marked layout-only by validateLinks)
                for (const link of [...model.links]) {
                    if (link.linkState?.[Reactodia.TemplateProperties.LayoutOnly]) {
                        model.removeLink(link.id);
                    }
                }
            }}>
            Refresh
        </Reactodia.ToolbarAction>
    );
}
