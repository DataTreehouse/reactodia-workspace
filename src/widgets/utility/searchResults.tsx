import * as React from 'react';

import {
    neverSyncStore, useEventStore, useFrameDebouncedStore, useSyncStore,
} from '../../coreUtils/hooks';
import { useTranslation } from '../../coreUtils/i18n';

import { ElementModel, ElementIri, ElementTypeIri } from '../../data/model';
import { getAllPresentEntities } from '../../editor/dataDiagramModel';
import { useWorkspace } from '../../workspace/workspaceContext';

import { ListElementView, startDragElements } from './listElementView';
import {
    TreeList, TreeListState, type TreeListModel, type TreeListRenderItem,
    type TreeListFocusProps, type TreeListUpPath, type TreeListDownPath,
} from './treeList';

const CLASS_NAME = 'reactodia-search-results';

interface SearchResultsContext {
    readonly highlightText: string | undefined;
    readonly useDragAndDrop: boolean;
    readonly selection: ReadonlySet<ElementIri>;
    readonly onToggleGroup: (typeIri: ElementTypeIri) => void;
    readonly onSetSelected: (
        item: ElementModel,
        select: boolean,
        e: React.MouseEvent | React.KeyboardEvent
    ) => void;
}

const SearchResultsContext = React.createContext<SearchResultsContext | null>(null);

function useSearchResultsContext(): SearchResultsContext {
    const context = React.useContext(SearchResultsContext);
    if (!context) {
        throw new Error('Reactodia: missing search results context');
    }
    return context;
}

/**
 * Props for {@link SearchResults} component.
 *
 * @see {@link SearchResults}
 */
export interface SearchResultsProps {
    /**
     * List of entities to display.
     */
    items: ReadonlyArray<ElementModel>;
    /**
     * Set of selected entities from {@link items}.
     */
    selection: ReadonlySet<ElementIri>;
    /**
     * Handler to change a selected set of entities.
     */
    onSelectionChanged: (newSelection: ReadonlySet<ElementIri>) => void;
    /**
     * Whether to allow to select an entity from the list.
     *
     * **Default** is to disable an entity if it has been already placed on the canvas.
     */
    isItemDisabled?: (item: ElementModel) => boolean;
    /**
     * Text sub-string to highlight in the displayed entities.
     */
    highlightText?: string;
    /**
     * Whether to allow to drag entities from the list (e.g. onto the diagram canvas).
     *
     * @default true
     */
    useDragAndDrop?: boolean;
    /**
     * Whether to allow to select multiple items at the same time.
     *
     * It is possible to select a range of items by holding `Shift` when
     * selecting another item to select all other items in-between as well.
     *
     * @default true
     */
    multiSelection?: boolean;
    /**
     * Additional components to render after the result items.
     */
    footer?: React.ReactNode;
}

/**
 * Utility component to display a list of selectable entities, grouped by type.
 * Items with no type are shown as top-level nodes.
 *
 * @category Components
 */
export function SearchResults(props: SearchResultsProps) {
    const {
        items, selection, onSelectionChanged, isItemDisabled, highlightText,
        useDragAndDrop = true, multiSelection = true, footer,
    } = props;

    const rootProps = React.useMemo((): React.HTMLProps<HTMLUListElement> => ({
        className: `${CLASS_NAME}__root`,
        role: 'list',
        'aria-multiselectable': true,
    }), []);
    const forestProps = React.useMemo((): React.HTMLProps<HTMLUListElement> => ({}), []);
    const itemProps = React.useMemo((): React.HTMLProps<HTMLLIElement> => ({
        className: `${CLASS_NAME}__item`,
        role: 'listitem',
    }), []);

    const computeIsItemDisabled = useIsItemDisabledWithDefault(isItemDisabled);
    const extendedItems = React.useMemo(() => items.map((data): LeafItem => ({
        kind: 'leaf',
        data,
        active: !computeIsItemDisabled(data),
    })), [items, computeIsItemDisabled]);

    const latestItems = React.useRef(items);
    React.useEffect(() => {
        latestItems.current = items;
    });
    const lastSelected = React.useRef<ElementModel>();

    const [expandedGroups, setExpandedGroups] = React.useState<ReadonlySet<string>>(new Set());

    const toggleGroup = React.useCallback((typeIri: ElementTypeIri) => {
        const key = `__type__:${typeIri}`;
        setExpandedGroups(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    }, []);

    const handleSetExpanded = React.useCallback(
        (item: SearchResultItem, _path: TreeListDownPath, expand: boolean) => {
            if (item.kind !== 'group') { return; }
            const key = `__type__:${item.typeIri}`;
            setExpandedGroups(prev => {
                const next = new Set(prev);
                if (expand) { next.add(key); } else { next.delete(key); }
                return next;
            });
        },
        []
    );

    const expandedState = React.useMemo(() => {
        if (expandedGroups.size === 0) { return undefined; }
        return new TreeListState<boolean>(
            new Map(Array.from(expandedGroups, key => [key, {value: true}]))
        );
    }, [expandedGroups]);

    const topLevelItems = React.useMemo((): readonly SearchResultItem[] => {
        const groupMap = new Map<ElementTypeIri, LeafItem[]>();
        const untyped: LeafItem[] = [];
        for (const item of extendedItems) {
            const typeIri = item.data.types[0] as ElementTypeIri | undefined;
            if (typeIri) {
                if (!groupMap.has(typeIri)) { groupMap.set(typeIri, []); }
                groupMap.get(typeIri)!.push(item);
            } else {
                untyped.push(item);
            }
        }
        const groups: TypeGroupItem[] = Array.from(groupMap, ([typeIri, groupItems]) => ({
            kind: 'group' as const,
            typeIri,
            items: groupItems,
        }));
        return [...untyped, ...groups];
    }, [extendedItems]);

    const searchResultsContext = React.useMemo(
        (): SearchResultsContext => ({
            highlightText,
            useDragAndDrop,
            selection,
            onToggleGroup: toggleGroup,
            onSetSelected: (item, select, e) => {
                if (select) {
                    const prevSelected = lastSelected.current;
                    if (multiSelection && e.shiftKey && prevSelected) {
                        const lastIndex = latestItems.current
                            .findIndex(entity => entity.id === prevSelected.id);
                        const currentIndex = latestItems.current
                            .findIndex(entity => entity.id === item.id);
                        if (lastIndex >= 0 && currentIndex >= 0) {
                            const nextSelection = new Set(selection);
                            const endIndex = Math.max(lastIndex, currentIndex);
                            for (let i = Math.min(lastIndex, currentIndex); i <= endIndex; i++) {
                                nextSelection.add(latestItems.current[i].id);
                            }
                            onSelectionChanged(nextSelection);
                        }
                    } else if (!selection.has(item.id)) {
                        const nextSelection = new Set(multiSelection ? selection : undefined);
                        nextSelection.add(item.id);
                        onSelectionChanged(nextSelection);
                    }
                    lastSelected.current = item;
                } else {
                    if (selection.has(item.id)) {
                        const nextSelection = new Set(selection);
                        nextSelection.delete(item.id);
                        onSelectionChanged(nextSelection);
                    }
                }
            },
        }),
        [highlightText, useDragAndDrop, selection, onSelectionChanged, multiSelection, toggleGroup]
    );

    const renderItem = React.useCallback<TreeListRenderItem<SearchResultItem, boolean>>(
        ({item, path, focusProps, expanded, selected}) => {
            if (item.kind === 'group') {
                return (
                    <TypeGroupHeader item={item} focusProps={focusProps} expanded={expanded} />
                );
            }
            return <ResultItem item={item} path={path} focusProps={focusProps} selected={selected} />;
        },
        []
    );

    React.useEffect(() => {
        const leftovers = new Set(selection);
        for (const item of extendedItems) {
            if (item.active) {
                leftovers.delete(item.data.id);
            }
        }
        if (leftovers.size > 0) {
            onSelectionChanged(new Set(
                Array.from(selection).filter(iri => !leftovers.has(iri))
            ));
        }
    }, [computeIsItemDisabled]);

    return (
        <SearchResultsContext.Provider value={searchResultsContext}>
            <div className={CLASS_NAME}>
                <TreeList
                    model={SearchResultsModel}
                    items={topLevelItems}
                    renderItem={renderItem}
                    expanded={expandedState}
                    onSetExpanded={handleSetExpanded}
                    rootProps={rootProps}
                    forestProps={forestProps}
                    itemProps={itemProps}
                />
                {footer}
            </div>
        </SearchResultsContext.Provider>
    );
}

function useIsItemDisabledWithDefault(
    isItemDisabled: ((item: ElementModel) => boolean) | undefined
): (item: ElementModel) => boolean {
    const {model} = useWorkspace();
    const changeCellsStore = useFrameDebouncedStore(
        useEventStore(model.events, 'changeCells')
    );
    const cellsVersion = useSyncStore(
        isItemDisabled ? neverSyncStore() : changeCellsStore,
        () => model.cellsVersion
    );
    return React.useMemo(() => {
        if (isItemDisabled) {
            return isItemDisabled;
        }
        const presentEntities = getAllPresentEntities(model);
        return (item: ElementModel) => presentEntities.has(item.id);
    }, [isItemDisabled, cellsVersion]);
}

interface LeafItem {
    readonly kind: 'leaf';
    readonly data: ElementModel;
    readonly active: boolean;
}

interface TypeGroupItem {
    readonly kind: 'group';
    readonly typeIri: ElementTypeIri;
    readonly items: readonly LeafItem[];
}

type SearchResultItem = LeafItem | TypeGroupItem;

const SearchResultsModel: TreeListModel<SearchResultItem, boolean> = {
    getKey: item => item.kind === 'group' ? `__type__:${item.typeIri}` : item.data.id,
    getChildren: item => item.kind === 'group' ? item.items : undefined,
    getDefaultSelected: () => undefined,
    isActive: item => item.kind === 'group' ? true : item.active,
};

function TypeGroupHeader(props: {
    item: TypeGroupItem;
    focusProps: TreeListFocusProps;
    expanded: boolean;
}) {
    const {item, focusProps, expanded} = props;
    const {model} = useWorkspace();
    const t = useTranslation();
    const {onToggleGroup} = useSearchResultsContext();

    const label = t.formatLabel(
        model.getElementType(item.typeIri)?.data?.label,
        item.typeIri,
        model.language
    );

    return (
        <button type='button' {...focusProps}
            className={`${CLASS_NAME}__type-group-header`}
            onClick={() => onToggleGroup(item.typeIri)}>
            {expanded ? '▼' : '▶'} {label} ({item.items.length})
        </button>
    );
}

function ResultItem(props: {
    item: LeafItem;
    path: TreeListUpPath;
    focusProps: TreeListFocusProps;
    selected: boolean | undefined;
}) {
    const {item, focusProps} = props;
    const {highlightText, useDragAndDrop, selection, onSetSelected} = useSearchResultsContext();
    const isSelected = selection.has(item.data.id);
    return (
        <ListElementView {...(item.active ? focusProps : undefined)}
            element={item.data}
            highlightText={highlightText}
            disabled={!item.active}
            selected={isSelected}
            onClick={item.active ? e => onSetSelected(item.data, !isSelected, e) : undefined}
            onKeyDown={e => {
                if (item.active && e.key === ' ') {
                    e.preventDefault();
                    onSetSelected(item.data, !isSelected, e);
                }
            }}
            onDragStart={useDragAndDrop ? e => {
                const iris: ElementIri[] = [];
                selection.forEach(iri => iris.push(iri));
                if (!selection.has(item.data.id)) {
                    iris.push(item.data.id);
                }
                return startDragElements(e, iris);
            } : undefined}
        />
    );
}
