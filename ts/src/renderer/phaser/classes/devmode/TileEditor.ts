class TileEditor {
	tilePalette: TilePalette;

	marker: TileMarker;
	paletteMarker: TileMarker;

	paletteArea: Vector2D;
	brushArea: TileShape;

	selectedTileArea: Record<number, Record<number, number>>;
	lastSelectedTileArea: Record<number, Record<number, number>>;
	commandController: CommandController;
	startDragIn: string;

	tileSize: number;
	prevData: { edit: MapEditTool['edit'] } | undefined;
	private pendingEditQueue: Array<{ tileX: number; tileY: number; sample: Record<number, Record<number, number>>; size: Vector2D; layer: number; x: number; y: number }> = [];
	private pendingEditFrame = false;
	private pendingWallPhysics = false;

	constructor(
		private gameScene: GameScene,
		devModeScene: DevModeScene,
		private devModeTools: DevModeTools,
		commandController: CommandController
	) {
		const palette = (this.tilePalette = this.devModeTools.palette);
		const gameMap = this.gameScene.tilemap;

		this.marker = new TileMarker(this.gameScene, devModeScene, gameMap, false, 2, commandController);
		this.paletteMarker = new TileMarker(
			this.devModeTools.scene,
			devModeScene,
			this.tilePalette.map,
			true,
			1,
			commandController
		);
		this.commandController = commandController;
		this.paletteArea = { x: 1, y: 1 };
		this.brushArea = new TileShape();
		this.selectedTileArea = {};

		const pointerPosition = { x: 0, y: 0 };

		this.activateMarkers(false);

		this.startDragIn = 'none';
		this.prevData = undefined;
		this.tileSize = Constants.TILE_SIZE;
		if (taro.game.data.defaultData.dontResize) {
			this.tileSize = gameMap.tileWidth;
		}
		taro.clearLayer = (payload: TileData<'clear'>) => {
			const map = taro.game.data.map;
			const tileMap = this.gameScene.tilemap as Phaser.Tilemaps.Tilemap;
			const nowLayerData = {};
			for (let x = 0; x < taro.map.data.width; x++) {
				for (let y = 0; y < taro.map.data.height; y++) {
					if (nowLayerData[x] === undefined) {
						nowLayerData[x] = {};
					}
					nowLayerData[x][y] = map.layers[payload.clear.layer].data[x + y * taro.map.data.width];
				}
			}
			const nowTileMapLayerData = tileMap.getLayer(payload.clear.layer).data;
			commandController.addCommand(
				{
					func: () => {
						taro.network.send<'clear'>('editTile', payload);
					},
					undo: () => {
						taro.network.send<'edit'>('editTile', {
							edit: {
								selectedTiles: [nowLayerData],
								size: 'fitContent',
								shape: 'rectangle',
								layer: [payload.clear.layer],
								x: 0,
								y: 0,
							},
						});
					},
				},
				true
			);
		};

		gameScene.input.on('pointerdown', (p) => {
			/*if (!devModeScene.pointerInsideButtons) {
				this.devModeTools.modeButtons.map((btn) => {
					btn.hideHoverChildren(0);
				});
			}*/

			if (
				!devModeScene.pointerInsideButtons &&
				!devModeScene.pointerInsideWidgets() &&
				(!palette.visible || !devModeScene.pointerInsidePalette()) &&
				this.gameScene.tilemap.currentLayerIndex >= 0 &&
				devModeScene.input.manager.activePointer.rightButtonDown()
			) {
				this.startDragIn = 'map';
				pointerPosition.x = gameScene.input.activePointer.x;
				pointerPosition.y = gameScene.input.activePointer.y;
			}
		});

		devModeScene.input.on('pointerdown', (p) => {
			/*if (!devModeScene.pointerInsideButtons) {
				this.devModeTools.modeButtons.map((btn) => {
					btn.hideHoverChildren(0);
				});
			}*/
			if (
				!devModeScene.pointerInsideButtons &&
				!devModeScene.pointerInsideWidgets() &&
				palette.visible &&
				devModeScene.pointerInsidePalette()
			) {
				this.startDragIn = 'palette';
				pointerPosition.x = devModeScene.input.activePointer.x;
				pointerPosition.y = devModeScene.input.activePointer.y;
				if (devModeTools.activeButton !== 'fill') {
					this.devModeTools.brush();
					this.devModeTools.activeButton = 'brush';
					taro.mapEditorUI.highlightModeButton('stamp');
				}
				if (p.button === 0) {
					this.selectedTileArea = {};
					this.clearTint();
				}
			}
		});

		devModeScene.input.on('pointermove', (p) => {
			if (devModeTools.activeButton === 'brush' && p.isDown && p.button === 0 && this.startDragIn === 'palette') {
				this.updateSelectedTiles(devModeScene);
			}
		});

		devModeScene.input.on('pointerup', (p) => {
			if (this.startDragIn === 'palette' && p.button === 0) {
				this.updateSelectedTiles(devModeScene);
			}
			if (this.startDragIn === 'palette') {
				this.startDragIn = 'none';
			}
		});

		gameScene.input.on('pointerup', (p) => {
			if (
				this.startDragIn === 'map' &&
				Math.abs(pointerPosition.x - gameScene.input.activePointer.x) < 50 &&
				Math.abs(pointerPosition.y - gameScene.input.activePointer.y) < 50 &&
				devModeTools.activeButton !== 'eraser'
			) {
				const worldPoint = gameScene.cameras.main.getWorldPoint(
					gameScene.input.activePointer.x,
					gameScene.input.activePointer.y
				);
				const nowBrushSize = JSON.parse(JSON.stringify(this.brushArea.size));
				if (this.devModeTools.isForceTo1x1()) {
					nowBrushSize.x = 1;
					nowBrushSize.y = 1;
				}
				const pointerTileX = gameMap.worldToTileX(worldPoint.x - ((nowBrushSize.x - 1) * this.tileSize) / 2, true);
				const pointerTileY = gameMap.worldToTileY(worldPoint.y - ((nowBrushSize.y - 1) * this.tileSize) / 2, true);
				this.clearTint();
				this.selectedTileArea = {};
				for (let i = 0; i < nowBrushSize.x; i++) {
					for (let j = 0; j < nowBrushSize.y; j++) {
						const tile = this.getTile(pointerTileX + i, pointerTileY + j, gameMap);
						if (tile !== -1) {
							if (!this.selectedTileArea[pointerTileX + i]) {
								this.selectedTileArea[pointerTileX + i] = {};
							}
							this.selectedTileArea[pointerTileX + i][pointerTileY + j] = tile;
						}
					}
				}
				this.marker.changePreview();
			}
			if (this.startDragIn === 'map') {
				this.startDragIn = 'none';
			}
		});
	}

	updateSelectedTiles(devModeScene: DevModeScene) {
		const palettePoint = devModeScene.cameras
			.getCamera('palette')
			.getWorldPoint(devModeScene.input.activePointer.x, devModeScene.input.activePointer.y);
		const palettePointerTileX = this.tilePalette.map.worldToTileX(palettePoint.x);
		const palettePointerTileY = this.tilePalette.map.worldToTileY(palettePoint.y);
		if (!this.selectedTileArea[palettePointerTileX]) {
			this.selectedTileArea[palettePointerTileX] = {};
		}
		const tile = this.getTile(palettePointerTileX, palettePointerTileY, this.tilePalette.map);
		this.selectedTileArea[palettePointerTileX][palettePointerTileY] = tile;
		this.marker.changePreview();
	}

	activateMarkers(active: boolean): void {
		this.marker.active = active;
		this.paletteMarker.active = active;
		if (active) this.devModeTools.regionEditor.regionTool = false;
	}

	showMarkers(value: boolean): void {
		this.marker.graphics.setVisible(value);
		this.marker.showPreview(value);
		this.paletteMarker.graphics.setVisible(value);
	}

	clearTint(): void {
		this.tilePalette.map.layers[0].data.forEach((tilearray) => {
			tilearray.forEach((tile) => {
				if (tile) tile.tint = 0xffffff;
			});
		});
	}

	private queueEdit(dataValue: TileData<'edit'>['edit']): void {
		dataValue.selectedTiles.forEach((selectedTiles, idx) => {
			const layer = dataValue.layer[idx];
			const layerData = taro.game.data.map.layers[layer];
			if (!layerData || layerData.type !== 'tilelayer' || !layerData.data) return;

			const calcData = this.brushArea.calcSample(selectedTiles, dataValue.size, dataValue.shape, true);
			const size = dataValue.size === 'fitContent' ? { x: calcData.xLength, y: calcData.yLength } : dataValue.size;
			const tileX = dataValue.size === 'fitContent' ? calcData.minX : dataValue.x;
			const tileY = dataValue.size === 'fitContent' ? calcData.minY : dataValue.y;

			this.pendingEditQueue.push({
				tileX,
				tileY,
				sample: calcData.sample,
				size,
				layer,
				x: 0,
				y: 0,
			});
		});
		this.scheduleEditFrame();
	}

	private scheduleEditFrame(): void {
		if (this.pendingEditFrame) return;
		this.pendingEditFrame = true;
		requestAnimationFrame(() => {
			this.pendingEditFrame = false;
			this.processEditQueue();
		});
	}

	/**
	 * Fast path for editor tile changes. Phaser's putTileAt() performs a lot of
	 * tile bookkeeping that is unnecessary when only the tile index changes.
	 * The editor already maintains the Taro map data and handles wall physics
	 * separately, so updating the existing Tile object directly avoids the large
	 * per-tile cost that made bulk edits hitch.
	 */
	private setTileIndexFast(
		map: Phaser.Tilemaps.Tilemap,
		tileX: number,
		tileY: number,
		index: number,
		layer: number
	): void {
		const layerData = map.layers[layer];
		const tile = layerData?.data?.[tileY]?.[tileX];

		if (tile) {
			tile.index = index;
			tile.tint = 0xffffff;
			return;
		}

		// Sparse layers can legitimately contain null entries. Preserve the
		// old behavior for those rare cells by letting Phaser create the Tile.
		map.putTileAt(index, tileX, tileY, false, layer);
		const fallbackTile = map.layers[layer]?.data?.[tileY]?.[tileX];
		if (fallbackTile) fallbackTile.tint = 0xffffff;
	}

	private processEditQueue(): void {
		const start = performance.now();
		const frameBudget = 4;
		const maxTilesPerFrame = 500;
		let processed = 0;
		const map = this.gameScene.tilemap as Phaser.Tilemaps.Tilemap;
		const taroMap = taro.game.data.map;
		const width = taroMap.width;

		while (this.pendingEditQueue.length && processed < maxTilesPerFrame && performance.now() - start < frameBudget) {
			const job = this.pendingEditQueue[0];
			const layerData = taroMap.layers[job.layer];
			if (!layerData || layerData.type !== 'tilelayer' || !layerData.data) {
				this.pendingEditQueue.shift();
				continue;
			}

			let jobFinished = true;
			for (; job.x < job.size.x; job.x++) {
				for (; job.y < job.size.y; job.y++) {
					const sampleColumn = job.sample[job.x];
					if (sampleColumn && sampleColumn[job.y] !== undefined && DevModeScene.pointerInsideMap(job.tileX + job.x, job.tileY + job.y, map)) {
						let index = sampleColumn[job.y];
						if (index === -1) index = 0;
						const mapIndex = (job.tileY + job.y) * width + job.tileX + job.x;
						if (layerData.data[mapIndex] !== index) {
							let phaserIndex = index === 0 ? -1 : index;
							if (this.gameScene.tilemapLayers[job.layer]?.visible !== false) {
								this.setTileIndexFast(map, job.tileX + job.x, job.tileY + job.y, phaserIndex, job.layer);
							}
							layerData.data[mapIndex] = index;
						}
						processed++;
						if (processed >= maxTilesPerFrame || performance.now() - start >= frameBudget) {
							jobFinished = false;
							break;
						}
					}
				}
				if (!jobFinished) break;
				job.y = 0;
			}

			if (jobFinished) {
				this.pendingEditQueue.shift();
			}
		}

		if (this.pendingEditQueue.length) {
			this.scheduleEditFrame();
		} else if (this.pendingWallPhysics) {
			this.pendingWallPhysics = false;
			if (taro.physics) debounceRecalcPhysics(taroMap, true);
		}
	}

	edit<T extends MapEditToolEnum>(data: TileData<T>): void {
		if (JSON.stringify(data) === '{}') {
			throw 'receive: {}';
		}
		const map = taro.game.data.map;
		inGameEditor.mapWasEdited && inGameEditor.mapWasEdited();
		const width = map.width;
		const { dataType, dataValue } = Object.entries(data).map(([k, v]) => {
			const dataType = k as MapEditToolEnum;
			const dataValue = v as any;
			return { dataType, dataValue };
		})[0];
		let tempLayer = dataType === 'edit' ? dataValue.layer[0] : dataValue.layer;

		switch (dataType) {
			case 'fill': {
				const nowValue = dataValue as TileData<'fill'>['fill'];
				const oldTile = map.layers[tempLayer].data[nowValue.y * width + nowValue.x];
				if (map.layers[nowValue.layer].type === 'tilelayer' && map.layers[nowValue.layer].data) {
					this.floodFill(nowValue.layer, oldTile, nowValue.gid, nowValue.x, nowValue.y, true, nowValue.limits);
				}
				break;
			}
			case 'edit': {
				this.queueEdit(dataValue as TileData<'edit'>['edit']);
				if (taro.physics && map.layers[tempLayer]?.name === 'walls') {
					this.pendingWallPhysics = true;
				}
				return;
			}
			case 'clear': {
				const nowValue = dataValue as TileData<'clear'>['clear'];
				if (map.layers[nowValue.layer].type === 'tilelayer' && map.layers[nowValue.layer].data) {
					this.clearLayer(nowValue.layer);
				}
				break;
			}
		}
		if (taro.physics && map.layers[tempLayer]?.name === 'walls') {
			if (dataValue.noMerge) recalcWallsPhysics(map, true);
			else debounceRecalcPhysics(map, true);
		}
	}

	/**
	 * put tiles
	 * @param tileX pointerTileX
	 * @param tileY pointerTileY
	 * @param selectedTiles selectedTiles
	 * @param brushSize brush's size
	 * @param layer layer
	 * @param local is not, it will send command to other client
	 */
	putTiles(
		tileX: number,
		tileY: number,
		selectedTiles: Record<number, Record<number, number>>,
		brushSize: Vector2D | 'fitContent',
		shape: Shape,
		layer: number,
		local?: boolean
	): void {
		const map = this.gameScene.tilemap as Phaser.Tilemaps.Tilemap;
		const calcData = this.brushArea.calcSample(selectedTiles, brushSize, shape, true);
		const sample = calcData.sample;
		const size = brushSize === 'fitContent' ? { x: calcData.xLength, y: calcData.yLength } : brushSize;
		const taroMap = taro.game.data.map;
		const width = taroMap.width;
		tileX = brushSize === 'fitContent' ? calcData.minX : tileX;
		tileY = brushSize === 'fitContent' ? calcData.minY : tileY;
		if (taroMap.layers[layer].data && this.gameScene.tilemapLayers[layer].visible && selectedTiles) {
			for (let x = 0; x < size.x; x++) {
				for (let y = 0; y < size.y; y++) {
					if (sample[x] && sample[x][y] !== undefined && DevModeScene.pointerInsideMap(tileX + x, tileY + y, map)) {
						let index = sample[x][y];
						const tile = map.layers[layer]?.data?.[tileY + y]?.[tileX + x];
						const currentIndex = tile ? tile.index : map.getTileAt(tileX + x, tileY + y, true, layer)?.index;
						if (index !== currentIndex && !(index === 0 && currentIndex === -1)) {
							if (index === 0) index = -1;
							this.setTileIndexFast(map, tileX + x, tileY + y, index, layer);
							if (index === -1) index = 0;
							taroMap.layers[layer].data[(tileY + y) * width + tileX + x] = index;
						}
					}
				}
			}
		}
		if (!local) {
			const data: { edit: MapEditTool['edit'] } = {
				edit: {
					size: brushSize,
					layer: [layer],
					selectedTiles: [selectedTiles],
					x: tileX,
					y: tileY,
					shape,
					noMerge: true,
				},
			};
			if (this.prevData === undefined || JSON.stringify(this.prevData) !== JSON.stringify(data)) {
				taro.network.send<'edit'>('editTile', data);
				this.prevData = data;
			}
		}
	}

	getTile(tileX: number, tileY: number, map: Phaser.Tilemaps.Tilemap): number {
		if (DevModeScene.pointerInsideMap(tileX, tileY, map)) {
			if (map.getTileAt(tileX, tileY) && map.getTileAt(tileX, tileY).index !== 0) {
				let selectedTile = map.getTileAt(tileX, tileY);
				return selectedTile.index;
			}
		}
		return -1;
	}

	floodFill(
		layer: number,
		oldTile: number,
		newTile: number,
		x: number,
		y: number,
		fromServer: boolean,
		limits?: Record<number, Record<number, number>>,
		addToLimits?: (v2d: Vector2D) => void
	): void {
		let map: MapData | Phaser.Tilemaps.Tilemap;
		const openQueue: Vector2D[] = [{ x, y }];
		const closedQueue: Record<number, Record<number, number>> = {};
		while (openQueue.length !== 0) {
			const nowPos = openQueue[0];
			openQueue.shift();
			if (closedQueue[nowPos.x]?.[nowPos.y]) {
				continue;
			}
			if (!closedQueue[nowPos.x]) {
				closedQueue[nowPos.x] = {};
			}
			closedQueue[nowPos.x][nowPos.y] = 1;
			if (newTile === 0 || newTile === null) {
				newTile = -1;
			}
			if (fromServer) {
				map = taro.game.data.map;
				inGameEditor.mapWasEdited && inGameEditor.mapWasEdited();
				const tileMap = this.gameScene.tilemap as Phaser.Tilemaps.Tilemap;
				const width = map.width;
				if (limits?.[nowPos.x]?.[nowPos.y]) {
					continue;
				}
				if (map.layers[layer].data[nowPos.y * width + nowPos.x] !== oldTile) {
					addToLimits?.({ x: nowPos.x, y: nowPos.y });
					continue;
				}
				this.setTileIndexFast(tileMap, nowPos.x, nowPos.y, newTile, layer);
				//save tile change to taro.game.map.data
				if (newTile === -1) {
					newTile = 0;
				}
				map.layers[layer].data[nowPos.y * width + nowPos.x] = newTile;
			} else {
				map = this.gameScene.tilemap as Phaser.Tilemaps.Tilemap;
				const nowTile = map.getTileAt(nowPos.x, nowPos.y, true, layer);
				if (limits?.[nowPos.x]?.[nowPos.y]) {
					continue;
				}
				if (nowTile !== undefined && nowTile !== null && nowTile.index !== oldTile) {
					addToLimits?.({ x: nowPos.x, y: nowPos.y });
					continue;
				}

				this.setTileIndexFast(map as Phaser.Tilemaps.Tilemap, nowPos.x, nowPos.y, newTile, layer);
			}
			if (nowPos.x > 0 && !closedQueue[nowPos.x - 1]?.[nowPos.y]) {
				openQueue.push({ x: nowPos.x - 1, y: nowPos.y });
			}
			if (nowPos.x < map.width - 1 && !closedQueue[nowPos.x + 1]?.[nowPos.y]) {
				openQueue.push({ x: nowPos.x + 1, y: nowPos.y });
			}
			if (nowPos.y > 0 && !closedQueue[nowPos.x]?.[nowPos.y - 1]) {
				openQueue.push({ x: nowPos.x, y: nowPos.y - 1 });
			}
			if (nowPos.y < map.height - 1 && !closedQueue[nowPos.x]?.[nowPos.y + 1]) {
				openQueue.push({ x: nowPos.x, y: nowPos.y + 1 });
			}
		}
	}

	clearLayer(layer: number): void {
		const map = taro.game.data.map;
		inGameEditor.mapWasEdited && inGameEditor.mapWasEdited();
		const tileMap = this.gameScene.tilemap as Phaser.Tilemaps.Tilemap;
		const width = map.width;
		for (let i = 0; i < map.width; i++) {
			for (let j = 0; j < map.height; j++) {
				if (map.layers[layer].data[j * width + i] !== 0) {
					this.setTileIndexFast(tileMap, i, j, -1, layer);
					//save tile change to taro.game.map.data
					map.layers[layer].data[j * width + i] = 0;
				}
			}
		}
	}

	changeLayerOpacity(layer: number, opacity: number): void {
		const map = taro.game.data.map;
		if (map.layers[layer]) {
			map.layers[layer].opacity = opacity;
			const tileMapLayer = this.gameScene.tilemapLayers[layer];
			if (tileMapLayer) {
				tileMapLayer.alpha = opacity;
			}
		}
	}

	update(): void {
		if (taro.developerMode.active && taro.developerMode.activeTab === 'map') {
			const devModeScene = this.devModeTools.scene;
			const palette = this.tilePalette;
			const map = this.gameScene.tilemap as Phaser.Tilemaps.Tilemap;
			const paletteMap = palette.map;
			const worldPoint = this.gameScene.cameras.main.getWorldPoint(
				this.gameScene.input.activePointer.x,
				this.gameScene.input.activePointer.y
			);
			const palettePoint = devModeScene.cameras
				.getCamera('palette')
				.getWorldPoint(devModeScene.input.activePointer.x, devModeScene.input.activePointer.y);
			const marker = this.marker;
			const paletteMarker = this.paletteMarker;
			paletteMarker.graphics.setVisible(true);
			marker.graphics.setVisible(false);
			marker.showPreview(false);

			// Rounds down to nearest tile
			const palettePointerTileX = paletteMap.worldToTileX(palettePoint.x);
			const palettePointerTileY = paletteMap.worldToTileY(palettePoint.y);

			if (palette.visible && devModeScene.pointerInsidePalette()) {
				devModeScene.regionEditor.cancelDrawRegion();
				marker.graphics.setVisible(false);
				marker.showPreview(false);

				// Snap to tile coordinates, but in world space
				paletteMarker.graphics.x = paletteMap.tileToWorldX(palettePointerTileX);
				paletteMarker.graphics.y = paletteMap.tileToWorldY(palettePointerTileY);
			} else if (
				(!devModeScene.pointerInsidePalette() || !palette.visible) &&
				!devModeScene.pointerInsideButtons &&
				!devModeScene.pointerInsideWidgets() &&
				map.currentLayerIndex >= 0
			) {
				taro.client.emit('update-tooltip', {
					label: 'Position',
					text:
						`X: ${Math.floor(worldPoint.x).toString()}, Y: ${Math.floor(worldPoint.y).toString()}  \n` +
						`Tile X: ${Math.floor(worldPoint.x / taro.scaleMapDetails.tileWidth).toString()}, Tile Y: ${Math.floor(worldPoint.y / taro.scaleMapDetails.tileHeight).toString()}`,
				});

				if (marker.active) {
					paletteMarker.graphics.setVisible(false);
					marker.graphics.setVisible(true);
					marker.showPreview(true);

					// Rounds down to nearest tile
					const pointerTileX = map.worldToTileX(
						worldPoint.x - ((marker.graphics.scaleSidesX - 1) * this.tileSize) / 2,
						true
					);
					const pointerTileY = map.worldToTileY(
						worldPoint.y - ((marker.graphics.scaleSidesY - 1) * this.tileSize) / 2,
						true
					);

					// Snap to tile coordinates, but in world space
					marker.graphics.x = map.tileToWorldX(pointerTileX);
					marker.graphics.y = map.tileToWorldY(pointerTileY);
					marker.preview.x = map.tileToWorldX(pointerTileX);
					marker.preview.y = map.tileToWorldY(pointerTileY);

					if (
						map?.getTileAt(pointerTileX, pointerTileY)?.index &&
						map?.getTileAt(pointerTileX, pointerTileY)?.index !== -1 &&
						map?.getTileAt(pointerTileX, pointerTileY)?.index !== 0
					) {
						taro.client.emit('update-tooltip', {
							label: 'Position',
							text:
								`X: ${Math.floor(worldPoint.x).toString()}, Y: ${Math.floor(worldPoint.y).toString()}  \n` +
								`Tile X: ${Math.floor(worldPoint.x / taro.scaleMapDetails.tileWidth).toString()}, Tile Y: ${Math.floor(worldPoint.y / taro.scaleMapDetails.tileHeight).toString()}  |  ` +
								`Tile id: ${map.getTileAt(pointerTileX, pointerTileY).index}`,
						});
					}

					if (devModeScene.input.manager.activePointer.leftButtonDown()) {
						if (this.devModeTools.activeButton === 'brush' || this.devModeTools.activeButton === 'eraser') {
							const originTileArea = {};
							const nowBrushSize = JSON.parse(JSON.stringify(this.brushArea.size)) as Vector2D;
							const nowBrushShape = JSON.parse(JSON.stringify(this.brushArea.shape)) as Shape;
							const sample = JSON.parse(JSON.stringify(this.brushArea.sample));
							const selectedTiles = JSON.parse(JSON.stringify(this.selectedTileArea));
							const nowLayer = map.currentLayerIndex;
							if (
								taro.game.data.map.layers[nowLayer].type === 'tilelayer' &&
								taro.game.data.map.layers[nowLayer].data
							) {
								Object.entries(sample).map(([x, obj]) => {
									Object.entries(obj).map(([y, value]) => {
										if (!originTileArea[x]) {
											originTileArea[x] = {};
										}
										originTileArea[x][y] = this.getTile(pointerTileX + parseInt(x), pointerTileY + parseInt(y), map);
									});
								});

								this.commandController.addCommand({
									func: () => {
										this.putTiles(
											pointerTileX,
											pointerTileY,
											selectedTiles,
											nowBrushSize,
											nowBrushShape,
											nowLayer,
											false
										);
									},
									undo: () => {
										this.putTiles(
											pointerTileX,
											pointerTileY,
											originTileArea,
											nowBrushSize,
											nowBrushShape,
											nowLayer,
											false
										);
									},
								});
							}
						} else if (this.devModeTools.activeButton === 'fill') {
							const targetTile = this.getTile(pointerTileX, pointerTileY, map);
							const selectedTile = Object.values(Object.values(this.selectedTileArea)?.[0] || {})?.[0];
							if (
								selectedTile &&
								targetTile !== selectedTile &&
								(targetTile || map.currentLayerIndex === 0 || map.currentLayerIndex === 1)
							) {
								const nowCommandCount = this.commandController.nowInsertIndex;
								const addToLimits = (v2d: Vector2D) => {
									setTimeout(() => {
										const cache = this.commandController.commands[nowCommandCount]
											.cache as Record<number, Record<number, number>>;
										if (!cache[v2d.x]) {
											cache[v2d.x] = {};
										}
										cache[v2d.x][v2d.y] = 1;
									}, 0);
								};
								const nowLayer = map.currentLayerIndex;
								if (
									taro.game.data.map.layers[nowLayer].type === 'tilelayer' &&
									taro.game.data.map.layers[nowLayer].data
								) {
									this.commandController.addCommand(
										{
											func: () => {
												this.floodFill(
													nowLayer,
													targetTile,
													selectedTile,
													pointerTileX,
													pointerTileY,
													false,
													{},
													addToLimits
												);
												taro.network.send<'fill'>('editTile', {
													fill: {
														gid: selectedTile,
														layer: nowLayer,
														x: pointerTileX,
														y: pointerTileY,
													},
												});
											},
											undo: () => {
												this.floodFill(
													nowLayer,
													selectedTile,
													targetTile,
													pointerTileX,
													pointerTileY,
													false,
													this.commandController.commands[nowCommandCount].cache
												);
												taro.network.send<'fill'>('editTile', {
													fill: {
														gid: targetTile,
														layer: nowLayer,
														x: pointerTileX,
														y: pointerTileY,
														limits:
															this.commandController.commands[nowCommandCount].cache,
													},
												});
											},
											cache: {},
										},
										true
									);
								}
							}
						}
					}
				} else if (this.devModeTools.entityEditor.selectedEntityImage) {
					taro.client.emit('update-tooltip', {
						label: 'Entity Position',
						text: `X: ${this.devModeTools.entityEditor.selectedEntityImage.image.x.toString()}, Y: ${this.devModeTools.entityEditor.selectedEntityImage.image.y.toString()}`,
					});
				}
			} else {
				this.showMarkers(false);
			}
		} else {
			this.showMarkers(false);
		}
	}
}
