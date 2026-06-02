import cx from 'clsx';
import * as React from 'react';

import { EventObserver } from '../coreUtils/events';
import { useTranslation, TranslatedText } from '../coreUtils/i18n';

import { ElementModel, ElementIri, ElementTypeIri, LinkTypeIri } from '../data/model';
import { DataProviderLookupParams } from '../data/dataProvider';

import type { CanvasApi } from '../diagram/canvasApi';
import { placeElementsAroundTarget } from '../diagram/commands';
import { Element, VoidElement } from '../diagram/elements';
import { Vector, boundsOf } from '../diagram/geometry';

import {
    DataGraphStructure, requestElementData, restoreLinksBetweenElements,
} from '../editor/dataDiagramModel';
import { EntityElement, EntityGroup, iterateEntitiesOf } from '../editor/dataElements';

import { WorkspaceEventKey, useWorkspace } from '../workspace/workspaceContext';
import { InstancesSearchTopic } from '../workspace/commandBusTopic';

import { InlineEntity } from './utility/inlineEntity';
import { NoSearchResults } from './utility/noSearchResults';
import { ProgressBar, ProgressState } from './utility/progressBar';
import { SearchInput, SearchInputStore, useSearchInputStore } from './utility/searchInput';
import { SearchResults } from './utility/searchResults';

/**
 * Props for {@link InstancesSearch} component.
 *
 * @see {@link InstancesSearch}
 */
export interface InstancesSearchProps {
    /**
     * Additional CSS class for the component.
     */
    className?: string;
    /**
     * Controlled search input state store.
     *
     * If specified, renders the component in "headless" mode
     * without a text filter input.
     */
    searchStore?: SearchInputStore;
    /**
     * Debounce timeout in milliseconds after input to perform the text search.
     *
     * If set to `explicit`, the search will require explicit `Enter` keypress or
     * submit button click to initiate.
     *
     * @default "explicit"
     */
    searchTimeout?: number | 'explicit';
    /**
     * Minimum number of characters in the search term to initiate the search.
     *
     * @default 3
     */
    minSearchTermLength?: number;
    /**
     * Handler for the search criteria changes.
     */
    onChangeCriteria?: (criteria: SearchCriteria) => void;
    /**
     * Handler to call when elements are added from the results onto the canvas.
     *
     * This handler is called only when elements are added by explicit "Add ..."
     * button press and not via drag and drop.
     */
    onAddElements?: (elements: Element[]) => void;
}

/**
 * Events for {@link InstancesSearch} event bus.
 *
 * @see {@link InstancesSearch}
 * @see {@link InstancesSearchTopic}
 */
export interface InstancesSearchCommands {
    /**
     * Triggered on a request to query implementations for its capabilities.
     */
    findCapabilities: {
        /**
         * Collects found instances search capabilities.
         */
        readonly capabilities: Array<Record<string, never>>;
    };
    /**
     * Can be triggered to set filter criteria and initiate the search.
     */
    setCriteria: {
        /**
         * Filter criteria to use for the search.
         */
        readonly criteria: SearchCriteria;
    };
}

/**
 * A filter criteria for the entity lookup from a {@link DataProvider}.
 *
 * @see {@link DataProviderLookupParams}
 */
export interface SearchCriteria {
    /**
     * Filter by a text lookup.
     */
    readonly text?: string;
    /**
     * Filter by an element type.
     */
    readonly elementType?: ElementTypeIri;
    /**
     * Filter by having a connected element with specified IRI.
     */
    readonly refElement?: ElementIri;
    /**
     * Filter by connection link type.
     *
     * Only applicable when {@link refElement} is set.
     */
    readonly refElementLink?: LinkTypeIri;
    /**
     * Reference element link type direction ('in' | 'out').
     *
     * Only when {@link refElementLink} is set.
     */
    readonly linkDirection?: 'in' | 'out';
}

/**
 * Component to search for entities by various filter criteria
 * to add them as elements to the diagram.
 *
 * @category Components
 */
export function InstancesSearch(props: InstancesSearchProps) {
    const {
        className,
        searchStore: controlledSearchStore,
        searchTimeout = 'explicit',
        minSearchTermLength = 3,
        onChangeCriteria,
        onAddElements,
    } = props;

    const uncontrolledSearch = useSearchInputStore({
        initialValue: '',
        submitTimeout: searchTimeout,
        allowSubmit: term => term.length >= minSearchTermLength,
    });
    const searchStore = controlledSearchStore ?? uncontrolledSearch;
    const isControlled = Boolean(controlledSearchStore);

    const workspace = useWorkspace();
    const {model, view, triggerWorkspaceEvent} = workspace;
    const t = useTranslation();

    // Bundle criteria + limit so they change atomically; limit resets on every criteria change.
    const [queryRequest, setQueryRequest] = React.useState<QueryRequest>({
        criteria: {},
        limit: ITEMS_PER_PAGE,
    });
    const criteria = queryRequest.criteria;

    const [querying, setQuerying] = React.useState(false);
    const [error, setError] = React.useState<unknown>();
    const [items, setItems] = React.useState<ReadonlyArray<ElementModel>>();
    const [resultId, setResultId] = React.useState(0);
    const [moreItemsAvailable, setMoreItemsAvailable] = React.useState(false);
    const [selection, setSelection] = React.useState<ReadonlySet<ElementIri>>(new Set());

    // Trigger re-render when model entity labels change (used by criteria display).
    const [, forceUpdate] = React.useReducer(n => n + 1, 0);

    // Keep latest callback in a ref so effects never capture a stale version.
    const onChangeCriteriaRef = React.useRef(onChangeCriteria);
    React.useEffect(() => { onChangeCriteriaRef.current = onChangeCriteria; });

    const applyAndNotifyCriteria = (newCriteria: SearchCriteria) => {
        setQueryRequest({criteria: newCriteria, limit: ITEMS_PER_PAGE});
        onChangeCriteriaRef.current?.(newCriteria);
    };

    // Re-render on language change; reset on new diagram load.
    React.useEffect(() => {
        const listener = new EventObserver();
        listener.listen(model.events, 'changeLanguage', forceUpdate);
        listener.listen(model.events, 'loadingStart', () => {
            setQueryRequest({criteria: {}, limit: ITEMS_PER_PAGE});
            searchStore.change({value: '', action: 'clear'});
        });
        return () => listener.stopListening();
    }, [model, searchStore]);

    // Advertise capabilities and handle external criteria changes via command bus.
    React.useEffect(() => {
        const listener = new EventObserver();
        const commands = workspace.getCommandBus(InstancesSearchTopic);
        listener.listen(commands, 'findCapabilities', e => {
            e.capabilities.push({});
        });
        listener.listen(commands, 'setCriteria', ({criteria: newCriteria}) => {
            triggerWorkspaceEvent(WorkspaceEventKey.searchUpdateCriteria);
            setQueryRequest({criteria: newCriteria, limit: ITEMS_PER_PAGE});
            searchStore.change({value: newCriteria.text ?? '', action: 'clear'});
            onChangeCriteriaRef.current?.(newCriteria);
        });
        return () => listener.stopListening();
    }, [workspace, searchStore, triggerWorkspaceEvent]);

    // Update text criteria from search input; does NOT trigger onChangeCriteria.
    React.useEffect(() => {
        const listener = new EventObserver();
        listener.listen(searchStore.events, 'executeSearch', ({value}) => {
            const text = value === '' ? undefined : value;
            setQueryRequest(prev =>
                prev.criteria.text === text ? prev :
                {criteria: {...prev.criteria, text}, limit: ITEMS_PER_PAGE}
            );
        });
        listener.listen(searchStore.events, 'clearSearch', () => {
            setQueryRequest(prev =>
                prev.criteria.text === undefined ? prev :
                {criteria: {...prev.criteria, text: undefined}, limit: ITEMS_PER_PAGE}
            );
        });
        return () => listener.stopListening();
    }, [searchStore]);

    // Re-render criteria display when related model entity labels change.
    React.useEffect(() => {
        const listener = new EventObserver();
        if (criteria.elementType) {
            const elementType = model.createElementType(criteria.elementType);
            if (elementType) {
                listener.listen(elementType.events, 'changeData', forceUpdate);
            }
        }
        if (criteria.refElement) {
            const element = model.elements.find(
                (el): el is EntityElement =>
                    el instanceof EntityElement && el.iri === criteria.refElement
            );
            if (element) {
                listener.listen(element.events, 'changeData', forceUpdate);
            }
        }
        if (criteria.refElementLink) {
            const linkType = model.createLinkType(criteria.refElementLink);
            if (linkType) {
                listener.listen(linkType.events, 'changeData', forceUpdate);
            }
        }
        return () => listener.stopListening();
    }, [criteria, model]);

    // Execute data provider query; aborts the previous request when queryRequest changes.
    React.useEffect(() => {
        const {criteria, limit} = queryRequest;
        if (!(criteria.text || criteria.elementType || criteria.refElement || criteria.refElementLink)) {
            setQuerying(false);
            setError(undefined);
            setItems(undefined);
            setSelection(new Set());
            setMoreItemsAvailable(false);
            return;
        }

        const isLoadMore = limit > ITEMS_PER_PAGE;
        const abortController = new AbortController();
        const request: DataProviderLookupParams = {
            ...createRequest(criteria),
            limit,
            signal: abortController.signal,
        };

        setQuerying(true);
        setError(undefined);
        setMoreItemsAvailable(false);

        model.dataProvider.lookup(request).then(elements => {
            if (abortController.signal.aborted) { return; }
            const moreAvailable =
                typeof limit === 'number' && elements.length >= limit;
            if (isLoadMore) {
                setItems(prev => {
                    const existingIds = new Set((prev ?? []).map(i => i.id));
                    const next = [...(prev ?? [])];
                    for (const {element} of elements) {
                        if (!existingIds.has(element.id)) { next.push(element); }
                    }
                    return next;
                });
            } else {
                setItems(elements.map(({element}) => element));
                setResultId(id => id + 1);
                setSelection(new Set());
            }
            setQuerying(false);
            setMoreItemsAvailable(moreAvailable);
            triggerWorkspaceEvent(WorkspaceEventKey.searchQueryItem);
        }).catch(err => {
            if (abortController.signal.aborted) { return; }
            console.error(err);
            setQuerying(false);
            setError(err as unknown);
        });

        return () => abortController.abort();
    }, [queryRequest, model, triggerWorkspaceEvent]);

    const handleLoadMore = () => {
        setQueryRequest(prev => ({...prev, limit: prev.limit + ITEMS_PER_PAGE}));
    };

    const placeSelectedItems = (mode: 'separately' | 'group') => {
        const canvas = view.findAnyCanvas();
        if (!canvas || selection.size === 0) { return; }

        const batch = model.history.startBatch(
            TranslatedText.text('search_entities.place_elements.command')
        );
        const selectedEntities = items
            ? items.filter(item => selection.has(item.id))
            : Array.from(selection, EntityElement.placeholderData);

        let elements: Element[];
        if (mode === 'separately') {
            const target = new VoidElement({
                position: getViewportPlacementPosition(canvas, 0.3, 0.5),
            });
            elements = selectedEntities.map(entity => model.createElement(entity));
            canvas.renderingState.syncUpdate();
            batch.history.execute(placeElementsAroundTarget({
                target,
                elements,
                graph: model,
                sizeProvider: canvas.renderingState,
                distance: 150,
            }));
        } else {
            const group = new EntityGroup({
                items: selectedEntities.map(data => ({data})),
                position: getViewportPlacementPosition(canvas, 0.5, 0.5),
            });
            elements = [group];
            model.addElement(group);
            canvas.renderingState.syncUpdate();
            const {x, y, width, height} = boundsOf(group, canvas.renderingState);
            group.setPosition({x: x - width / 2, y: y - height / 2});
        }

        const addedElements = Array.from(selection);
        batch.history.execute(requestElementData(model, addedElements));
        batch.history.execute(restoreLinksBetweenElements(model, {addedElements}));
        batch.store();

        onAddElements?.(elements);
    };

    const progressState: ProgressState = (
        querying ? 'loading' :
        error ? 'error' :
        items ? 'completed' :
        'none'
    );

    const resultItems = items ?? [];
    const actionsAreHidden = querying || selection.size === 0;

    return (
        <div className={cx(
            CLASS_NAME,
            isControlled ? `${CLASS_NAME}--controlled` : undefined,
            className
        )}>
            <div className={`${CLASS_NAME}__criteria`}>
                <CriteriaDisplay
                    criteria={criteria}
                    onRemoveElementType={() => applyAndNotifyCriteria(
                        {...criteria, elementType: undefined}
                    )}
                    onRemoveRefElement={() => applyAndNotifyCriteria(
                        {...criteria, refElement: undefined, refElementLink: undefined}
                    )}
                />
                {isControlled ? null : (
                    <SearchInput store={searchStore}
                        className={`${CLASS_NAME}__text-criteria`}
                        inputProps={{
                            name: 'reactodia-instances-search-text',
                            placeholder: t.textOptional('search_entities.input.placeholder'),
                        }}
                    />
                )}
            </div>
            <ProgressBar state={progressState}
                title={t.text('search_entities.query_progress.title')}
            />
            {/* key resets scroll position when new search results are loaded */}
            <div key={resultId}
                className={`${CLASS_NAME}__rest reactodia-scrollable`}
                tabIndex={-1}>
                <SearchResults
                    items={resultItems}
                    highlightText={criteria.text}
                    selection={selection}
                    onSelectionChanged={setSelection}
                    footer={
                        resultItems.length === 0 ? (
                            <NoSearchResults hasQuery={items !== undefined}
                                minSearchTermLength={minSearchTermLength}
                            />
                        ) : null
                    }
                />
                <div className={`${CLASS_NAME}__rest-end`}>
                    <button type='button'
                        className={`${CLASS_NAME}__load-more reactodia-btn reactodia-btn-primary`}
                        disabled={querying}
                        style={{display: moreItemsAvailable ? undefined : 'none'}}
                        title={t.text('search_entities.show_more_results.title')}
                        onClick={handleLoadMore}>
                        {t.text('search_entities.show_more_results.label')}
                    </button>
                </div>
            </div>
            <div
                className={cx(
                    `${CLASS_NAME}__actions`,
                    actionsAreHidden ? `${CLASS_NAME}__actions-hidden` : undefined
                )}
                aria-hidden={actionsAreHidden ? 'true' : undefined}>
                <button type='button'
                    className={`${CLASS_NAME}__action reactodia-btn reactodia-btn-secondary`}
                    disabled={querying || selection.size <= 1}
                    title={t.text('search_entities.add_group.title')}
                    onClick={() => placeSelectedItems('group')}>
                    {t.text('search_entities.add_group.label')}
                </button>
                <button type='button'
                    className={`${CLASS_NAME}__action reactodia-btn reactodia-btn-primary`}
                    disabled={querying || selection.size === 0}
                    title={t.text('search_entities.add_selected.title')}
                    onClick={() => placeSelectedItems('separately')}>
                    {t.text('search_entities.add_selected.label')}
                </button>
            </div>
        </div>
    );
}

interface QueryRequest {
    readonly criteria: SearchCriteria;
    readonly limit: number;
}

const CLASS_NAME = 'reactodia-instances-search';
const ITEMS_PER_PAGE = 100;

function CriteriaDisplay(props: {
    criteria: SearchCriteria;
    onRemoveElementType: () => void;
    onRemoveRefElement: () => void;
}) {
    const {criteria, onRemoveElementType, onRemoveRefElement} = props;
    const {model} = useWorkspace();
    const t = useTranslation();

    const criterions: React.ReactElement[] = [];

    if (criteria.elementType) {
        const elementTypeInfo = model.getElementType(criteria.elementType);
        const elementTypeLabel = t.formatLabel(
            elementTypeInfo?.data?.label,
            criteria.elementType,
            model.language
        );
        criterions.push(
            <div key='hasType' className={`${CLASS_NAME}__criterion`}>
                <RemoveCriterionButton onClick={onRemoveElementType} />
                {t.template('search_entities.criteria_has_type', {
                    entityType: (
                        <span className={`${CLASS_NAME}__criterion-class`}
                            title={criteria.elementType}>
                            {elementTypeLabel}
                        </span>
                    )
                })}
            </div>
        );
    } else if (criteria.refElement) {
        const refElementData = findEntityData(model, criteria.refElement)
            ?? EntityElement.placeholderData(criteria.refElement);

        let linkTypeLabel: string | undefined;
        if (criteria.refElementLink) {
            const linkTypeData = model.getLinkType(criteria.refElementLink);
            linkTypeLabel = t.formatLabel(
                linkTypeData?.data?.label,
                criteria.refElementLink,
                model.language
            );
        }

        const entity = <InlineEntity target={refElementData} />;
        const relationType = criteria.refElementLink ? (
            <span className={`${CLASS_NAME}__criterion-link-type`}
                title={criteria.refElementLink}>
                {linkTypeLabel}
            </span>
        ) : undefined;
        const sourceIcon = <span className={`${CLASS_NAME}__link-direction-in`} />;
        const targetIcon = <span className={`${CLASS_NAME}__link-direction-out`} />;

        criterions.push(
            <div key='hasLinkedElement' className={`${CLASS_NAME}__criterion`}>
                <RemoveCriterionButton onClick={onRemoveRefElement} />
                {!criteria.refElementLink ? (
                    t.template('search_entities.criteria_connected', {
                        entity, relationType, sourceIcon, targetIcon,
                    })
                ) : criteria.linkDirection === 'in' ? (
                    t.template('search_entities.criteria_connected_to_source', {
                        entity, relationType, sourceIcon, targetIcon,
                    })
                ) : criteria.linkDirection === 'out' ? (
                    t.template('search_entities.criteria_connected_to_target', {
                        entity, relationType, sourceIcon, targetIcon,
                    })
                ) : (
                    t.template('search_entities.criteria_connected_via', {
                        entity, relationType, sourceIcon, targetIcon,
                    })
                )}
            </div>
        );
    }

    return <div className={`${CLASS_NAME}__criterions`}>{criterions}</div>;
}

function RemoveCriterionButton(props: {onClick: () => void}) {
    return (
        <div className={`${CLASS_NAME}__criterion-remove reactodia-btn-group reactodia-btn-group-xs`}>
            <button type='button' title='Remove criteria'
                className={cx(
                    `${CLASS_NAME}__criterion-remove-button`,
                    'reactodia-btn reactodia-btn-default'
                )}
                onClick={props.onClick}>
            </button>
        </div>
    );
}

function findEntityData(graph: DataGraphStructure, iri: ElementIri): ElementModel | undefined {
    for (const element of graph.elements) {
        for (const entity of iterateEntitiesOf(element)) {
            if (entity.id === iri) {
                return entity;
            }
        }
    }
    return undefined;
}

export function createRequest(criteria: SearchCriteria): DataProviderLookupParams {
    const {text, elementType, refElement, refElementLink, linkDirection} = criteria;
    return {
        text,
        elementTypeId: elementType,
        refElementId: refElement,
        refElementLinkId: refElementLink,
        linkDirection,
        limit: ITEMS_PER_PAGE,
    };
}

function getViewportPlacementPosition(canvas: CanvasApi, fractionX: number, fractionY: number): Vector {
    const viewport = canvas.metrics.pane;
    return canvas.metrics.clientToPaperCoords(
        viewport.clientWidth * fractionX,
        viewport.clientHeight * fractionY
    );
}
