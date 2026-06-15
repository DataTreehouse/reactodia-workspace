import * as N3 from 'n3';

import * as Rdf from '../rdf/rdfModel';
import { rdfs, schema } from '../rdf/vocabulary';
import {
    ElementTypeGraph, ElementTypeModel, LinkTypeModel, ElementModel, LinkModel, PropertyTypeModel,
    ElementIri, ElementTypeIri, LinkTypeIri, PropertyTypeIri,
} from '../model';
import {
    DataProvider, DataProviderLinkCount, DataProviderLookupParams, DataProviderLookupItem,
} from '../dataProvider';
import {
    MutableClassModel, MutableLinkType, MutablePropertyModel,
    appendProperty,
    collectClassInfo, collectElementTypes, collectLinkTypes, collectPropertyInfo,
    enrichElementsWithImages, getClassTree, getElementsInfo, getLinkTypes, getLinksInfo,
    getConnectedLinkTypes, getFilteredData, getLinkStatistics, triplesToElementBinding,
} from '../sparql/responseHandler';
import {
    ClassBinding, ElementBinding, LinkBinding, PropertyBinding, FilterBinding,
    LinkCountBinding, LinkTypeBinding, ConnectedLinkTypeBinding, ElementImageBinding, ElementTypeBinding,
    SparqlResponse, mapSparqlResponseIntoRdfJs,
} from '../sparql/sparqlModels';

/**
 * Options for {@link HttpApiDataProvider}.
 *
 * @see {@link HttpApiDataProvider}
 */
export interface HttpApiDataProviderOptions {
    /**
     * Base URL of the HTTP API (e.g. `"http://localhost:8000"`).
     */
    baseUrl: string;

    /**
     * [RDF/JS-compatible term factory](https://rdf.js.org/data-model-spec/#datafactory-interface)
     * to create RDF terms.
     */
    factory?: Rdf.DataFactory;

    /**
     * Element property type IRIs to use to get image URLs for elements.
     */
    imagePropertyUris?: ReadonlyArray<string>;

    /**
     * Allows to extract/fetch image URLs externally.
     */
    prepareImages?: (
        elementInfo: Iterable<ElementModel>,
        signal: AbortSignal | undefined
    ) => Promise<Map<ElementIri, string>>;

    /**
     * Property IRI to store prepared image URL for an entity.
     *
     * @default "http://schema.org/thumbnailUrl"
     */
    prepareImagePredicate?: PropertyTypeIri;

    /**
     * Allows to extract/fetch labels separately as an alternative or
     * in addition to labels returned by the API.
     */
    prepareLabels?: (
        resources: Set<string>,
        signal: AbortSignal | undefined
    ) => Promise<Map<string, Rdf.Literal[]>>;

    /**
     * Property IRI to store prepared labels for an entity.
     *
     * @default "http://www.w3.org/2000/01/rdf-schema#label"
     */
    prepareLabelPredicate?: PropertyTypeIri;
}

/**
 * Provides graph data by requesting it from an HTTP API backed by pre-built SPARQL queries.
 *
 * Each method maps to a dedicated endpoint defined in the OpenAPI specification:
 * - `knownElementTypes` → `GET /api/class-tree`
 * - `elementTypes`      → `POST /api/class-info`
 * - `propertyTypes`     → `POST /api/property-info`
 * - `linkTypes`         → `POST /api/link-types-info`
 * - `knownLinkTypes`    → `GET /api/link-types`
 * - `elements`          → `POST /api/element-info` + `POST /api/element-types` (parallel)
 * - `links`             → `POST /api/links-info`
 * - `connectedLinkStats`→ `POST /api/link-types-of` + `POST /api/link-types-statistics` per type
 * - `lookup`            → `POST /api/lookup`
 *
 * @category Data
 */
export class HttpApiDataProvider implements DataProvider {
    readonly factory: Rdf.DataFactory;
    private readonly options: HttpApiDataProviderOptions;
    private readonly labelPredicate: PropertyTypeIri;
    private readonly imagePredicate: PropertyTypeIri;

    constructor(options: HttpApiDataProviderOptions) {
        const {factory = Rdf.DefaultDataFactory} = options;
        this.factory = factory;
        this.options = options;
        this.labelPredicate = options.prepareLabelPredicate ?? rdfs.label;
        this.imagePredicate = options.prepareImagePredicate ?? schema.thumbnailUrl;
    }

    private buildUrl(path: string): string {
        return this.options.baseUrl.replace(/\/$/, '') + path;
    }

    private async fetchRaw(
        path: string,
        body?: object,
        signal?: AbortSignal
    ): Promise<Response> {
        const response = await fetch(this.buildUrl(path), {
            method: body !== undefined ? 'POST' : 'GET',
            headers: body !== undefined ? {'Content-Type': 'application/json'} : {},
            body: body !== undefined ? JSON.stringify(body) : undefined,
            credentials: 'same-origin',
            mode: 'cors',
            cache: 'no-cache',
            signal,
        });
        if (!response.ok) {
            const error = new Error(response.statusText);
            (error as {response?: Response}).response = response;
            throw error;
        }
        return response;
    }

    private async fetchJson<T>(
        path: string,
        body?: object,
        signal?: AbortSignal
    ): Promise<T> {
        const response = await this.fetchRaw(path, body, signal);
        return response.json() as T;
    }

    private async fetchTurtle(
        path: string,
        body?: object,
        signal?: AbortSignal
    ): Promise<Rdf.Quad[]> {
        const response = await this.fetchRaw(path, body, signal);
        const turtleText = await response.text();
        return new N3.Parser().parse(turtleText);
    }

    private mapResponse<T>(raw: SparqlResponse<unknown>): SparqlResponse<T> {
        return mapSparqlResponseIntoRdfJs(raw, this.factory) as SparqlResponse<T>;
    }

    /** `GET /api/class-tree` */
    async knownElementTypes(params: {signal?: AbortSignal}): Promise<ElementTypeGraph> {
        const {signal} = params;
        const raw = await this.fetchJson<SparqlResponse<unknown>>('/api/class-tree', undefined, signal);
        const classTree = getClassTree(this.mapResponse<ClassBinding>(raw));

        if (this.options.prepareLabels) {
            await attachLabels(classTree.elementTypes, this.options.prepareLabels, signal);
        }
        return classTree;
    }

    /** `POST /api/class-info` with `{ ids }` */
    async elementTypes(params: {
        classIds: ReadonlyArray<ElementTypeIri>;
        signal?: AbortSignal;
    }): Promise<Map<ElementTypeIri, ElementTypeModel>> {
        const {classIds, signal} = params;
        const classes = new Map<ElementTypeIri, MutableClassModel>();

        if (classIds.length > 0) {
            const raw = await this.fetchJson<SparqlResponse<unknown>>(
                '/api/class-info', {ids: classIds}, signal
            );
            collectClassInfo(this.mapResponse<ClassBinding>(raw), classes);
        }

        if (this.options.prepareLabels) {
            await attachLabels(Array.from(classes.values()), this.options.prepareLabels, signal);
        }
        return classes;
    }

    /** `POST /api/property-info` with `{ ids }` */
    async propertyTypes(params: {
        propertyIds: ReadonlyArray<PropertyTypeIri>;
        signal?: AbortSignal;
    }): Promise<Map<PropertyTypeIri, PropertyTypeModel>> {
        const {propertyIds, signal} = params;
        const properties = new Map<PropertyTypeIri, MutablePropertyModel>();

        if (propertyIds.length > 0) {
            const raw = await this.fetchJson<SparqlResponse<unknown>>(
                '/api/property-info', {ids: propertyIds}, signal
            );
            collectPropertyInfo(this.mapResponse<PropertyBinding>(raw), properties);
        }

        if (this.options.prepareLabels) {
            await attachLabels(Array.from(properties.values()), this.options.prepareLabels, signal);
        }
        return properties;
    }

    /** `POST /api/link-types-info` with `{ ids }` */
    async linkTypes(params: {
        linkTypeIds: ReadonlyArray<LinkTypeIri>;
        signal?: AbortSignal;
    }): Promise<Map<LinkTypeIri, LinkTypeModel>> {
        const {linkTypeIds, signal} = params;
        const linkTypes = new Map<LinkTypeIri, MutableLinkType>();

        if (linkTypeIds.length > 0) {
            const raw = await this.fetchJson<SparqlResponse<unknown>>(
                '/api/link-types-info', {ids: linkTypeIds}, signal
            );
            collectLinkTypes(this.mapResponse<LinkTypeBinding>(raw), linkTypes);
        }

        if (this.options.prepareLabels) {
            await attachLabels(Array.from(linkTypes.values()), this.options.prepareLabels, signal);
        }
        return linkTypes;
    }

    /** `GET /api/link-types` */
    async knownLinkTypes(params: {signal?: AbortSignal}): Promise<LinkTypeModel[]> {
        const {signal} = params;
        const raw = await this.fetchJson<SparqlResponse<unknown>>('/api/link-types', undefined, signal);
        const linkTypes = getLinkTypes(this.mapResponse<LinkTypeBinding>(raw));

        if (this.options.prepareLabels) {
            await attachLabels(Array.from(linkTypes.values()), this.options.prepareLabels, signal);
        }
        return Array.from(linkTypes.values());
    }

    /** `POST /api/element-info` (Turtle CONSTRUCT) + `POST /api/element-types` (parallel) */
    async elements(params: {
        elementIds: ReadonlyArray<ElementIri>;
        signal?: AbortSignal;
    }): Promise<Map<ElementIri, ElementModel>> {
        const {elementIds, signal} = params;

        if (elementIds.length === 0) {
            return new Map();
        }

        const [triples, elementTypesRaw] = await Promise.all([
            this.fetchTurtle('/api/element-info', {ids: elementIds}, signal),
            this.fetchJson<SparqlResponse<unknown>>('/api/element-types', {ids: elementIds}, signal),
        ]);

        const types = new Map<ElementIri, Set<ElementTypeIri>>();
        collectElementTypes(this.mapResponse<ElementTypeBinding>(elementTypesRaw), types);

        const elementModels = getElementsInfo(
            triplesToElementBinding(triples),
            types,
            new Map(),
            this.labelPredicate,
            true
        );

        if (this.options.prepareLabels) {
            await attachProperties(
                Array.from(elementModels.values()),
                this.options.prepareLabels,
                this.labelPredicate,
                signal
            );
        }

        if (this.options.prepareImages) {
            await prepareElementImages(
                elementModels, this.options.prepareImages, this.imagePredicate, this.factory, signal
            );
        } else if (this.options.imagePropertyUris && this.options.imagePropertyUris.length > 0) {
            await this.attachImages(elementModels, this.options.imagePropertyUris, signal);
        }

        return elementModels;
    }

    /** `POST /api/images` with `{ ids, image_properties }` */
    private async attachImages(
        elements: Map<ElementIri, ElementModel>,
        imagePropertyIris: ReadonlyArray<string>,
        signal: AbortSignal | undefined
    ): Promise<void> {
        try {
            const raw = await this.fetchJson<SparqlResponse<unknown>>(
                '/api/images',
                {ids: Array.from(elements.keys()), image_properties: imagePropertyIris},
                signal
            );
            enrichElementsWithImages(this.mapResponse<ElementImageBinding>(raw), elements, this.imagePredicate);
        } catch (err) {
            console.warn('Failed to load entity image URLs', err);
        }
    }

    /** `POST /api/links-info` with `{ source_iris, target_iris }` */
    async links(params: {
        primary: ReadonlyArray<ElementIri>;
        secondary: ReadonlyArray<ElementIri>;
        linkTypeIds?: ReadonlyArray<LinkTypeIri>;
        signal?: AbortSignal;
    }): Promise<LinkModel[]> {
        const {primary, secondary, linkTypeIds, signal} = params;

        if (primary.length === 0 || secondary.length === 0) {
            return [];
        }

        const raw = await this.fetchJson<SparqlResponse<unknown>>(
            '/api/links-info',
            {source_iris: primary, target_iris: secondary},
            signal
        );
        const response = this.mapResponse<LinkBinding>(raw);

        let linksInfo = getLinksInfo(response.results.bindings, new Map(), new Map(), true);
        if (linkTypeIds) {
            const allowedLinkTypes = new Set(linkTypeIds);
            linksInfo = linksInfo.filter(link => allowedLinkTypes.has(link.linkTypeId));
        }
        return linksInfo;
    }

    /** `POST /api/link-types-of` then `POST /api/link-types-statistics` per link type */
    async connectedLinkStats(params: {
        elementId: ElementIri;
        inexactCount?: boolean;
        signal?: AbortSignal;
    }): Promise<DataProviderLinkCount[]> {
        const {elementId, inexactCount, signal} = params;

        const linkTypesRaw = await this.fetchJson<SparqlResponse<unknown>>(
            '/api/link-types-of', {element_iri: elementId}, signal
        );
        const linkTypesResponse = this.mapResponse<ConnectedLinkTypeBinding>(linkTypesRaw);
        const hasConnectedDirection = linkTypesResponse.head.vars.includes('direction');
        const connectedLinkTypes = getConnectedLinkTypes(linkTypesResponse, new Map(), true);

        const foundLinkStats: DataProviderLinkCount[] = [];
        await Promise.all(connectedLinkTypes.map(async ({linkType, hasInLink, hasOutLink}) => {
            if (inexactCount && hasConnectedDirection) {
                foundLinkStats.push({
                    id: linkType,
                    inCount: hasInLink ? 1 : 0,
                    outCount: hasOutLink ? 1 : 0,
                    inexact: true,
                });
            } else {
                const statsRaw = await this.fetchJson<SparqlResponse<unknown>>(
                    '/api/link-types-statistics',
                    {element_iri: elementId, link_type_iri: linkType},
                    signal
                );
                const linkStats = getLinkStatistics(this.mapResponse<LinkCountBinding>(statsRaw));
                if (linkStats) {
                    foundLinkStats.push(linkStats);
                }
            }
        }));

        return foundLinkStats;
    }

    /** `POST /api/lookup` with lookup parameters */
    async lookup(baseParams: DataProviderLookupParams): Promise<DataProviderLookupItem[]> {
        const {signal} = baseParams;
        const params: DataProviderLookupParams = {
            ...baseParams,
            limit: baseParams.limit === undefined ? 100 : baseParams.limit,
        };

        const body: Record<string, unknown> = {
            limit: typeof params.limit === 'number' ? params.limit : 100,
        };
        if (params.text !== undefined) { body.text = params.text; }
        if (params.elementTypeId !== undefined) { body.type_iri = params.elementTypeId; }
        if (params.refElementId !== undefined) { body.ref_element_iri = params.refElementId; }
        if (params.refElementLinkId !== undefined) { body.ref_element_link_iri = params.refElementLinkId; }
        if (params.linkDirection !== undefined) { body.direction = params.linkDirection; }

        const raw = await this.fetchJson<SparqlResponse<unknown>>('/api/lookup', body, signal);
        const response = this.mapResponse<ElementBinding & FilterBinding>(raw);

        const linkedElements = getFilteredData(response, undefined, new Map(), this.labelPredicate, true);

        if (this.options.prepareLabels) {
            await attachProperties(
                linkedElements.map(linked => linked.element),
                this.options.prepareLabels,
                this.labelPredicate,
                signal
            );
        }

        return linkedElements;
    }
}

interface LabeledItem {
    id: string;
    label: ReadonlyArray<Rdf.Literal>;
}

async function attachLabels(
    items: readonly LabeledItem[],
    fetchLabels: NonNullable<HttpApiDataProviderOptions['prepareLabels']>,
    signal: AbortSignal | undefined
): Promise<void> {
    const resources = new Set(items.map(item => item.id));
    const labels = await fetchLabels(resources, signal);
    for (const item of items) {
        const itemLabels = labels.get(item.id);
        if (itemLabels) {
            (item as {label: Rdf.Literal[]}).label = itemLabels;
        }
    }
}

type MutableProperties = Record<PropertyTypeIri, Array<Rdf.NamedNode | Rdf.Literal>>;

async function attachProperties(
    items: readonly ElementModel[],
    fetchProperties: NonNullable<HttpApiDataProviderOptions['prepareLabels']>,
    propertyIri: PropertyTypeIri,
    signal: AbortSignal | undefined
): Promise<void> {
    const resources = new Set(items.map(item => item.id));
    const properties = await fetchProperties(resources, signal);
    for (const item of items) {
        const itemValues = properties.get(item.id);
        if (itemValues) {
            (item.properties as MutableProperties)[propertyIri] = itemValues;
        }
    }
}

function prepareElementImages(
    elements: Map<ElementIri, ElementModel>,
    fetchImages: NonNullable<HttpApiDataProviderOptions['prepareImages']>,
    imagePropertyIri: PropertyTypeIri,
    factory: Rdf.DataFactory,
    signal: AbortSignal | undefined
): Promise<void> {
    return fetchImages(elements.values(), signal).then(images => {
        for (const [iri, image] of images) {
            const entity = elements.get(iri);
            if (entity) {
                appendProperty(
                    entity.properties as MutableProperties,
                    imagePropertyIri,
                    factory.namedNode(image)
                );
            }
        }
    });
}
