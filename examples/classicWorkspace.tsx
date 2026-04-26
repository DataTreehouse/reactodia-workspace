import * as React from 'react';
import * as N3 from 'n3';

import * as Reactodia from '../src/workspace';
import { SemanticTypeStyles, makeOntologyLinkTemplates } from '../src/legacy-styles';
const OntologyLinkTemplates = makeOntologyLinkTemplates(Reactodia);

import { ExampleMetadataProvider, ExampleValidationProvider } from './resources/exampleMetadata';
import {
    ExampleToolbarMenu,
    mountOnLoad,
    tryLoadLayoutFromLocalStorage,
    getHashQuery,
    setHashQueryParam
    } from './resources/common';
import {
    SparqlConnectionSettings, SparqlConnectionAction, showConnectionDialog,
} from './resources/sparqlConnection';

const Layouts = Reactodia.defineLayoutWorker(() => new Worker(
    new URL('../src/layout.worker.ts', import.meta.url),
    {type: 'module'}
));

function ClassicWorkspaceExample() {
    const {defaultLayout} = Reactodia.useWorker(Layouts);

    const [connectionSettings, setConnectionSettings] = React.useState(
        (): SparqlConnectionSettings | undefined => {
            const params = getHashQuery();
            const endpointUrl = "@ENDPOINT_URL@";
            return endpointUrl ? {
                endpointUrl,
            } : undefined;
        }
    );
    const applyConnectionSettings = (settings: SparqlConnectionSettings) => {
        setHashQueryParam('sparql-endpoint', settings.endpointUrl);
        setConnectionSettings(settings);
    };

    const {onMount} = Reactodia.useLoadedWorkspace(async ({context, signal}) => {
        const {model, editor} = context;
        editor.setAuthoringMode(true);

        const diagram = tryLoadLayoutFromLocalStorage();
        const dataProvider = new Reactodia.SparqlDataProvider({
                endpointUrl: connectionSettings.endpointUrl,
                imagePropertyUris: ['http://xmlns.com/foaf/0.1/img'],
                queryMethod: 'POST',
            }, Reactodia.OwlStatsSettings);
    
        await model.importLayout({
            diagram,
            dataProvider,
            validateLinks: true,
            signal,
        });
    }, [connectionSettings]);

    const [metadataProvider] = React.useState(() => new ExampleMetadataProvider());
    const [validationProvider] = React.useState(() => new ExampleValidationProvider());
    const [renameLinkProvider] = React.useState(() => new RenameSubclassOfProvider());

    return (
        <Reactodia.Workspace ref={onMount}
            defaultLayout={defaultLayout}
            metadataProvider={metadataProvider}
            validationProvider={validationProvider}
            renameLinkProvider={renameLinkProvider}
            typeStyleResolver={SemanticTypeStyles}>
            <Reactodia.ClassicWorkspace
                canvas={{
                    elementTemplateResolver: types => {
                        if (types.includes('http://www.w3.org/2002/07/owl#DatatypeProperty')) {
                            return Reactodia.ClassicTemplate;
                        }
                        return undefined;
                    },
                    linkTemplateResolver: linkType => {
                        if (linkType === 'http://www.w3.org/2000/01/rdf-schema#subClassOf') {
                            return Reactodia.DefaultLinkTemplate;
                        }
                        return OntologyLinkTemplates(linkType);
                    },
                }}
                toolbar={{
                    menu: (
                        <>
                            <ExampleToolbarMenu />
                        </>
                    ),
                }}
            />
        </Reactodia.Workspace>
    );
}

class RenameSubclassOfProvider extends Reactodia.RenameLinkToLinkStateProvider {
    override canRename(link: Reactodia.Link): boolean {
        return (
            link instanceof Reactodia.AnnotationLink ||
            link.typeId === 'http://www.w3.org/2000/01/rdf-schema#subClassOf'
        );
    }
}

mountOnLoad(<ClassicWorkspaceExample />);
