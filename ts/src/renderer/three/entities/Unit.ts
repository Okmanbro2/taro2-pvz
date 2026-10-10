namespace Renderer {
	export namespace Three {
		export class Unit extends Entity {
			cameraConfig = {
				pointerLock: false,
				pitchRange: { min: -90, max: 90 },
				offset: { x: 0, y: 0, z: 0 },
			};
			body: AnimatedSprite | Model | null = null;
			instancedIdx: number | null = null;
			instancedData: { depthZOffset: number } | null = null;
			textureId: string;
			size: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };

			private hud = new THREE.Group();
			private topHud = new THREE.Group();
			bottomHud = new THREE.Group();
			private label: Label;
			private topAttributes = new Attributes();
			private bottomAttributes = new Attributes();
			private chat: ChatBubble;

			constructor(
				public taroId: string,
				public ownerId: string,
				public taroEntity: TaroEntityPhysics,
				instancedMesh = false
			) {
				super(taroEntity);
				const renderer = Renderer.Three.instance();
				this.textureId = taroEntity._stats.cellSheet.url;
				if (!instancedMesh) {
					if (taroEntity._stats.is3DObject) {
						const name = taroEntity._stats.cellSheet.url;
						this.body = new Model(name, taroEntity);
					} else {
						const key = taroEntity._stats.cellSheet.url;
						const cols = taroEntity._stats.cellSheet.columnCount || 1;
						const rows = taroEntity._stats.cellSheet.rowCount || 1;
						const tex = gAssetManager.getTexture(key).clone();
						const frameWidth = tex.image.width / cols;
						const frameHeight = tex.image.height / rows;
						const spriteSheet = new TextureSheet(key, tex, frameWidth, frameHeight);
						this.body = new AnimatedSprite(spriteSheet);
					}
				} else {
					this.instancedIdx = renderer.projectilPool.createOrMergeProjectile(taroEntity._stats.cellSheet.url);
					this.instancedData = { depthZOffset: 0 };
				}

				if (this.body !== null) {
					this.add(this.body);
				}

				this.add(this.hud);
				this.hud.add(this.topHud);
				this.hud.add(this.bottomHud);

				this.topAttributes.position.y = Utils.pixelToWorld(8);
				this.bottomAttributes.position.y = -Utils.pixelToWorld(8);

				this.topHud.add(this.topAttributes);
				this.bottomHud.add(this.bottomAttributes);

				if (Utils.isDebug()) {
					const originHelper1 = new THREE.AxesHelper(0.1);
					this.topHud.add(originHelper1);

					const originHelper2 = new THREE.AxesHelper(0.1);
					this.bottomHud.add(originHelper2);

					const gridHelper1 = new THREE.GridHelper(1, 1);
					gridHelper1.rotateX(Math.PI * 0.5);
					gridHelper1.position.y = 0.5;
					gridHelper1.material.depthTest = false;
					gridHelper1.scale.x = Utils.pixelToWorld(96);
					this.topHud.add(gridHelper1);

					const gridHelper2 = gridHelper1.clone();
					gridHelper2.position.y = -0.5;
					this.bottomHud.add(gridHelper2);
				}

				this.label = new Label({ renderOnTop: true });
				this.label.visible = false;
				this.label.setCenterY(1);
				this.label.position.y = Utils.pixelToWorld(this.topAttributes.topBarsHeight + 16);
				this.topHud.add(this.label);

				if (this.body !== null) {
					if (this.body instanceof Sprite) {
						const size = this.body.getSize();
						if (this.body.billboard) {
							this.topHud.position.y = size.height;
							this.topHud.position.z = 0;

							this.bottomHud.position.y = 0;
							this.bottomHud.position.z = 0;
						} else {
							this.topHud.position.y = 0;
							this.topHud.position.z = -size.height * 0.5;

							this.bottomHud.position.y = 0;
							this.bottomHud.position.z = size.height * 0.5;
						}
					} else {
						const size = this.body.getSize();
						this.topHud.position.y = size.y;
					}
				}
			}

			static create(taroEntity: TaroEntityPhysics, instancedMesh = false) {
				const renderer = Three.instance();
				const entity = new Unit(taroEntity._id, taroEntity._stats.ownerId, taroEntity, instancedMesh);
				entity.setHudScale(1 / renderer.camera.lastAuthoritativeZoom);

				if (taroEntity._stats.cameraPointerLock) {
					entity.cameraConfig.pointerLock = taroEntity._stats.cameraPointerLock;
				}

				if (taroEntity._stats.cameraPitchRange) {
					entity.cameraConfig.pitchRange = taroEntity._stats.cameraPitchRange;
				}

				if (taroEntity._stats.cameraOffset) {
					// From editor XZY to Three.js XYZ
					entity.cameraConfig.offset.x = taroEntity._stats.cameraOffset.x;
					entity.cameraConfig.offset.y = taroEntity._stats.cameraOffset.z;
					entity.cameraConfig.offset.z = taroEntity._stats.cameraOffset.y;
				}

				taroEntity.on('show-label', () => (entity.label.visible = true));
				taroEntity.on('hide-label', () => (entity.label.visible = false));
				taroEntity.on('render-attributes', (data) => (entity as Unit).updateAttributes(data));
				taroEntity.on('update-attribute', (data) => (entity as Unit).updateAttribute(data));
				taroEntity.on('render-chat-bubble', (text) => (entity as Unit).renderChat(text));
				// instancedMesh
				if (entity.body === null) {
					taroEntity.on('depth', (depth) => (entity.instancedData['depthZOffset'] = Utils.getDepthZOffset(depth)));
				}
				if (entity.body instanceof AnimatedSprite) {
					taroEntity.on('depth', (depth) => (entity.body as AnimatedSprite).setDepth(depth));
					taroEntity.on('flip', (flip) => (entity.body as AnimatedSprite).setFlip(flip % 2 === 1, flip > 1));
					taroEntity.on('billboard', (isBillboard) =>
						(entity.body as AnimatedSprite).setBillboard(isBillboard, renderer.camera)
					);
				} else if (entity.body instanceof Model) {
					//FIXME: when the 3d physics is ready, remove this
					taroEntity.on('temp_translation_y', (positionY) => {
						entity.body.root.position.y = Utils.pixelToWorld(positionY);
					});
				}

				taroEntity.on(
					'transform',
					(data: { x: number; y: number; rotation: number }) => {
						if (
							entity.body !== null &&
							entity.position.x === Utils.pixelToWorld(data.x) &&
							entity.position.z === Utils.pixelToWorld(data.y) &&
							entity.body.rotation.y === -data.rotation
						) {
							return;
						}
						entity.position.x = Utils.pixelToWorld(data.x);
						entity.position.z = Utils.pixelToWorld(data.y);
						if (entity.body === null) {
							renderer.projectilPool.editInstanceMesh(
								{
									position: [
										entity.position.x,
										entity.position.y + entity.instancedData.depthZOffset,
										entity.position.z,
									],
									rotation: [0, -data.rotation, 0],
								},
								entity.textureId,
								entity.instancedIdx
							);
						} else {
							if (entity.body instanceof AnimatedSprite) {
								entity.body.rotation.y = -data.rotation;
								const flip = taroEntity._stats.flip;
								entity.body.setFlip(flip % 2 === 1, flip > 1);
							} else {
								entity.body.rotation.y = -data.rotation;
							}
						}
					},
					this
				);

				taroEntity.on('rotate', (x: number, y: number, z: number) => {
					if (
						entity.body !== null &&
						entity.body.root.rotation.x === Utils.deg2rad(x) &&
						entity.body.root.rotation.y === Utils.deg2rad(z) &&
						entity.body.root.rotation.z === Utils.deg2rad(y)
					) {
						return;
					}
					if (entity.body !== null) {
						entity.body.root.rotation.x = Utils.deg2rad(x);
						entity.body.root.rotation.y = Utils.deg2rad(z);
						entity.body.root.rotation.z = Utils.deg2rad(y);
					} else {
						renderer.projectilPool.editInstanceMesh(
							{ rotation: [Utils.deg2rad(x), Utils.deg2rad(y), Utils.deg2rad(z)] },
							entity.textureId,
							entity.instancedIdx
						);
					}
				});

				taroEntity.on(
					'size',
					(data: { width: number; height: number }) => {
						const width = Utils.pixelToWorld(data.width || 0);
						const height = Utils.pixelToWorld(data.height || 0);
						const depth = Utils.pixelToWorld(entity.taroEntity._stats?.currentBody?.depth || 0);
						if (entity.body !== null) {
							entity.setScale(width, height, depth);
						} else {
							renderer.projectilPool.editInstanceMesh(
								{ scale: [width, 1, height] },
								entity.textureId,
								entity.instancedIdx
							);
						}
					},
					this
				);

				taroEntity.on('update-label', (data) => {
					entity.label.visible = true;
					entity.label.update({ text: data.text, color: data.color, bold: data.bold });
				});

				taroEntity.on('play-animation', (id) => {
					if (entity.body instanceof AnimatedSprite) {
						const key = `${taroEntity._stats.cellSheet.url}/${id}/${taroEntity._stats.id}`;
						entity.body.play(key);
					} else {
						const anim = entity.taroEntity._stats.animations[id];
						if (anim) {
							const name = anim.threeAnimationKey || '';
							const loopCount = anim.loopCount || 0;
							entity.body?.play(name, loopCount);
						}
					}
				});

				taroEntity.on('update-texture', (data) => {
					const key = taroEntity._stats.cellSheet.url;

					if (entity.body instanceof Model) {
						const model = gAssetManager.getModelWithoutPlaceholder(key);

						if (model) {
							(entity.body as Model).setModel(model);
						} else {
							gAssetManager.load([{ name: key, type: 'gltf', src: Utils.patchAssetUrl(key) }], null, () => {
								(entity.body as Model).setModel(gAssetManager.getModel(key));
							});
						}
					} else if (entity.body instanceof Sprite) {
						const cols = taroEntity._stats.cellSheet.columnCount || 1;
						const rows = taroEntity._stats.cellSheet.rowCount || 1;
						const tex = gAssetManager.getTextureWithoutPlaceholder(key);

						const replaceTexture = (spriteSheet: TextureSheet) => {
							(entity.body as AnimatedSprite).setTextureSheet(spriteSheet);
							const bounds = taroEntity._bounds2d;
							entity.setScale(Utils.pixelToWorld(bounds.x), Utils.pixelToWorld(bounds.y), 1);
						};

						if (tex) {
							const frameWidth = tex.image.width / cols;
							const frameHeight = tex.image.height / rows;
							const sheet = new TextureSheet(key, tex.clone(), frameWidth, frameHeight);
							replaceTexture(sheet);
						} else {
							const animationMgr = AnimationManager.instance();
							gAssetManager.load([{ name: key, type: 'texture', src: Utils.patchAssetUrl(key) }], null, () => {
								const tex = gAssetManager.getTexture(key);
								animationMgr.createAnimationsFromTaroData(key, taroEntity._stats as unknown as EntityData);
								const frameWidth = tex.image.width / cols;
								const frameHeight = tex.image.height / rows;
								const sheet = new TextureSheet(key, tex.clone(), frameWidth, frameHeight);
								replaceTexture(sheet);
							});
						}
					}
				});

				taroEntity.on('fading-text', (data: { text: string; color?: string }) => {
					let unitHeightPx = 0;
					if (entity.body instanceof AnimatedSprite) {
						unitHeightPx = entity.body.getSizeInPixels().height;
					} else {
						unitHeightPx = Utils.worldToPixel(entity.body.getSize().y);
					}
					const offsetInPixels = -25 - unitHeightPx * 0.5;
					const text = new FloatingText(0, 0, 0, data.text || '', data.color || '#ffffff', 0, -offsetInPixels);
					entity.add(text);
				});

				taroEntity.on('set-opacity', (opacity) => {
					if (entity.body !== null) {
						entity.body.setOpacity(opacity);
					}
				});

				return entity;
			}

			update(dt: number) {
				if (this.body !== null) {
					this.body?.update(dt);

					const camera = Three.instance().camera.instance;
					if (this.body instanceof AnimatedSprite && this.body.billboard) {
						this.hud.quaternion.copy(camera.quaternion);
						this.hud.position.copy(this.body.position);
						this.topHud.position.y = this.body.getSize().height * 0.5;
						this.bottomHud.position.y = -this.body.getSize().height * 0.5;
					} else {
						this.topHud.quaternion.copy(camera.quaternion);
						this.bottomHud.quaternion.copy(camera.quaternion);
					}
				}
			}

			renderChat(text: string): void {
				if (this.chat) {
					this.chat.update({ text });
				} else {
					this.chat = new ChatBubble({ text });
					this.chat.position.copy(this.label.position);
					this.chat.position.y += Utils.pixelToWorld(this.label.height + 24);
					this.topHud.add(this.chat);
				}
			}

			updateAttributes(data) {
				this.topAttributes.clear();
				this.bottomAttributes.clear();

				for (const attr of data.attrs) {
					if (Mapper.ProgressBar(attr).anchorPosition != 'below') {
						this.topAttributes.addAttribute(attr);
					} else {
						this.bottomAttributes.addAttribute(attr);
					}
				}

				this.label.position.y = Utils.pixelToWorld(this.topAttributes.topBarsHeight + 16);
			}

			updateAttribute(data) {
				// NOTE(nick): Update might add an attribute so we need to check
				// if it's above or below.
				if (Mapper.ProgressBar(data.attr).anchorPosition != 'below') {
					this.topAttributes.update(data);
				} else {
					this.bottomAttributes.update(data);
				}
			}

			setScale(sx: number, sy: number, sz: number) {
				this.size.x = sx;
				this.size.y = sy;
				this.size.z = sz;

				if (this.body === null) {
					const renderer = Renderer.Three.instance();
					renderer.projectilPool.editInstanceMesh({ scale: [sx, sy, sz] }, this.textureId, this.instancedIdx);
				} else {
					if (this.body instanceof AnimatedSprite) {
						this.body.setScale(sx, sy);
					} else if (this.body instanceof Sprite) {
						// Sprite geometry is a plane whose visible dimensions are
						// controlled by Sprite.setScale; resizing only the entity/body
						// leaves the rendered sprite at its old size.
						this.body.setScale(sx, sz);
					} else {
						this.body.setSize(sx, sz, sy);
					}

					if (this.body instanceof Sprite) {
						const size = this.body.getSize();
						if (this.body.billboard) {
							this.topHud.position.y = size.height;
							this.topHud.position.z = 0;

							this.bottomHud.position.y = 0;
							this.bottomHud.position.z = 0;
						} else {
							this.topHud.position.y = 0;
							this.topHud.position.z = -size.height * 0.5;

							this.bottomHud.position.y = 0;
							this.bottomHud.position.z = size.height * 0.5;
						}
					} else {
						const size = this.body.getSize();
						this.topHud.position.y = size.y;
					}
				}
			}

			showHud(visible: boolean) {
				if (visible != this.hud.visible) {
					const fadeAnimation = (from: number, to: number, onComplete = () => {}) => {
						new TWEEN.Tween({ opacity: from })
							.to({ opacity: to }, 100)
							.onUpdate(({ opacity }) => {
								this.label.setOpacity(opacity);
								this.topAttributes.setOpacity(opacity);
								this.bottomAttributes.setOpacity(opacity);
							})
							.onComplete(onComplete)
							.start();
					};

					if (visible) {
						this.hud.visible = true;
						fadeAnimation(0, 1);
					} else {
						fadeAnimation(1, 0, () => (this.hud.visible = false));
					}
				}
			}

			setHudScale(scale: number) {
				this.topHud.scale.setScalar(scale);
				this.bottomHud.scale.setScalar(scale);
			}
		}
	}
}
