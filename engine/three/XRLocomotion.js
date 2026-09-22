import * as THREE from 'three';

/**
 * XRLocomotion
 *
 * Locomoción para Meta Quest / Pico / WebXR.
 *
 * Joystick izquierdo:
 *   - Movimiento horizontal.
 *
 * Joystick derecho:
 *   - Rotación.
 *
 * El tracking de cabeza NO se modifica manualmente.
 * WebXR / Three.js mantiene la orientación real del headset.
 */
export class XRLocomotion {

    constructor(renderer, camera, scene, options = {}) {

        this.renderer = renderer;
        this.camera = camera;
        this.scene = scene;

        this.device = options.device || 'quest';

        this.moveSpeed = options.moveSpeed ?? 2.0;
        this.rotateSpeed = options.rotateSpeed ?? 1.5;

        this.rotateMode = options.rotateMode || 'smooth';
        this.snapAngle = options.snapAngle ?? 45;

        this.deadzone = options.deadzone ?? 0.18;

        this.teleport = options.teleport ?? false;

        this.fixedHeight = options.fixedHeight ?? true;

        /*
         * En Meta Quest normalmente:
         *
         * axes[2] = X del joystick
         * axes[3] = Y del joystick
         *
         * Si ese par no existe se utiliza [0,1].
         */
        this.stickAxes = options.stickAxes || [2, 3];

        this.debugInput = options.debugInput ?? false;

        // ========================================================
        // RIG XR
        // ========================================================

        this.cameraRig = new THREE.Group();

        this.cameraRig.name = 'XRLocomotionRig';

        this.cameraRig.add(this.camera);

        this.scene.add(this.cameraRig);

        // ========================================================
        // ESTADO
        // ========================================================

        this._prevTime = null;

        this._snapReady = true;

        this._selecting = false;

        this._teleportTarget = null;

        // ========================================================
        // VECTORES AUXILIARES
        // ========================================================

        this._direction = new THREE.Vector3();

        this._right = new THREE.Vector3();

        this._forward = new THREE.Vector3();

        // ========================================================
        // CONTROLLERS
        // ========================================================

        this.controllers = [];

        this._lastDebugTime = 0;

        this._setupControllers();
    }


    // ============================================================
    // UPDATE
    // ============================================================

    update(time, frame) {

        if (!this.renderer.xr.isPresenting) {

            this._prevTime = time;

            return;
        }


        if (this._prevTime === null) {

            this._prevTime = time;

            return;
        }


        /*
         * Limitamos delta para evitar saltos si el navegador
         * se queda momentáneamente bloqueado.
         */
        const delta = Math.min(
            (time - this._prevTime) / 1000,
            0.05
        );


        this._prevTime = time;


        // ========================================================
        // QUEST / PICO
        // ========================================================

        if (
            this.device === 'quest' ||
            this.device === 'pico'
        ) {

            this._updateThumbstick(delta);

        } else {

            this._updateSelectMove(delta);
        }


        // ========================================================
        // TELEPORT
        // ========================================================

        if (this.teleport) {

            this._updateTeleport();
        }
    }


    // ============================================================
    // CONTROLLERS
    // ============================================================

    _setupControllers() {

        const controller0 =
            this.renderer.xr.getController(0);

        const controller1 =
            this.renderer.xr.getController(1);


        this.controllers = [
            controller0,
            controller1
        ];


        /*
         * Escuchamos ambos controladores.
         */
        for (const controller of this.controllers) {

            controller.addEventListener(
                'selectstart',
                () => {

                    this._selecting = true;
                }
            );


            controller.addEventListener(
                'selectend',
                () => {

                    this._selecting = false;
                }
            );


            this.scene.add(controller);
        }
    }


    // ============================================================
    // LEER JOYSTICK
    // ============================================================

    _readThumbstick(gamepad) {

        if (
            !gamepad ||
            !gamepad.axes
        ) {

            return {
                x: 0,
                y: 0,
                axes: null
            };
        }


        const axes = gamepad.axes;


        let xIndex =
            this.stickAxes[0];

        let yIndex =
            this.stickAxes[1];


        /*
         * Si Quest entrega axes[2]/axes[3],
         * los usamos.
         *
         * Si no existen, usamos axes[0]/axes[1].
         */
        if (
            axes.length <= Math.max(
                xIndex,
                yIndex
            )
        ) {

            xIndex = 0;

            yIndex = 1;
        }


        return {

            x: Number.isFinite(
                axes[xIndex]
            )
                ? axes[xIndex]
                : 0,

            y: Number.isFinite(
                axes[yIndex]
            )
                ? axes[yIndex]
                : 0,

            axes: [
                xIndex,
                yIndex
            ]
        };
    }


    // ============================================================
    // DEADZONE
    // ============================================================

    _applyDeadzone(value) {

        const absolute =
            Math.abs(value);


        if (
            absolute <
            this.deadzone
        ) {

            return 0;
        }


        const sign =
            Math.sign(value);


        const normalized =
            (
                absolute -
                this.deadzone
            ) /
            (
                1 -
                this.deadzone
            );


        return sign *
            Math.min(
                normalized,
                1
            );
    }


    // ============================================================
    // JOYSTICKS
    // ============================================================

    _updateThumbstick(delta) {

        const session =
            this.renderer.xr.getSession();


        if (!session) {

            return;
        }


        for (
            const source
            of session.inputSources
        ) {

            if (!source.gamepad) {

                continue;
            }


            const gamepad =
                source.gamepad;


            const handedness =
                source.handedness;


            const stick =
                this._readThumbstick(
                    gamepad
                );


            const x =
                this._applyDeadzone(
                    stick.x
                );


            const y =
                this._applyDeadzone(
                    stick.y
                );


            // ====================================================
            // DEBUG
            // ====================================================

            if (
                this.debugInput
            ) {

                this._debugInput(
                    source,
                    stick,
                    x,
                    y
                );
            }


            // ====================================================
            // JOYSTICK IZQUIERDO
            // MOVIMIENTO
            // ====================================================

            if (
                handedness === 'left'
            ) {

                if (
                    Math.abs(x) < 0.001 &&
                    Math.abs(y) < 0.001
                ) {

                    continue;
                }


                /*
                 * Obtenemos la cámara XR real.
                 *
                 * Esto es importante:
                 * no intentamos simular el movimiento
                 * de la cabeza.
                 */
                const xrCamera =
                    this.renderer.xr.getCamera(
                        this.camera
                    );


                /*
                 * Dirección de mirada.
                 */
                xrCamera.getWorldDirection(
                    this._forward
                );


                /*
                 * Solo movimiento horizontal.
                 */
                this._forward.y = 0;


                if (
                    this._forward.lengthSq() <
                    0.0001
                ) {

                    this._forward.set(
                        0,
                        0,
                        -1
                    );

                } else {

                    this._forward.normalize();
                }


                /*
                 * Vector lateral.
                 */
                this._right.crossVectors(
                    this._forward,
                    this.camera.up
                );


                if (
                    this._right.lengthSq() <
                    0.0001
                ) {

                    this._right.set(
                        1,
                        0,
                        0
                    );

                } else {

                    this._right.normalize();
                }


                /*
                 * Construimos dirección:
                 *
                 * joystick Y
                 * joystick X
                 */
                this._direction.set(
                    0,
                    0,
                    0
                );


                this._direction.addScaledVector(
                    this._forward,
                    -y
                );


                this._direction.addScaledVector(
                    this._right,
                    x
                );


                this._direction.y = 0;


                if (
                    this._direction.lengthSq() >
                    0.0001
                ) {

                    this._direction.normalize();


                    const distance =
                        this.moveSpeed *
                        delta;


                    this.cameraRig.position
                        .addScaledVector(
                            this._direction,
                            distance
                        );
                }
            }


            // ====================================================
            // JOYSTICK DERECHO
            // ROTACIÓN
            // ====================================================

            if (
                handedness === 'right'
            ) {

                if (
                    Math.abs(x) < 0.001
                ) {

                    continue;
                }


                // ==================================================
                // ROTACIÓN SNAP
                // ==================================================

                if (
                    this.rotateMode === 'snap'
                ) {

                    this._updateSnapRotation(
                        x
                    );

                }

                // ==================================================
                // ROTACIÓN SUAVE
                // ==================================================

                else {

                    this.cameraRig.rotation.y -=
                        x *
                        this.rotateSpeed *
                        delta;
                }
            }
        }
    }


    // ============================================================
    // SNAP ROTATION
    // ============================================================

    _updateSnapRotation(x) {

        const threshold = 0.7;


        if (
            Math.abs(x) >
            threshold &&
            this._snapReady
        ) {

            const angle =
                THREE.MathUtils.degToRad(
                    this.snapAngle
                ) *
                Math.sign(x);


            this.cameraRig.rotation.y -=
                angle;


            this._snapReady = false;
        }


        /*
         * Rearmar cuando el joystick
         * vuelve al centro.
         */
        if (
            Math.abs(x) < 0.3
        ) {

            this._snapReady = true;
        }
    }


    // ============================================================
    // MOVIMIENTO POR MIRADA
    // ============================================================

    _updateGazeMove(delta) {

        const xrCamera =
            this.renderer.xr.getCamera(
                this.camera
            );


        xrCamera.getWorldDirection(
            this._direction
        );


        this._direction.y = 0;


        if (
            this._direction.lengthSq() <
            0.0001
        ) {

            return;
        }


        this._direction.normalize();


        this.cameraRig.position
            .addScaledVector(
                this._direction,
                this.moveSpeed *
                delta
            );
    }


    // ============================================================
    // SELECT MOVE
    // ============================================================

    _updateSelectMove(delta) {

        if (
            this._selecting
        ) {

            this._updateGazeMove(
                delta
            );
        }
    }


    // ============================================================
    // TELEPORT
    // ============================================================

    _updateTeleport() {

        if (
            !this._teleportTarget
        ) {

            return;
        }


        this.cameraRig.position.copy(
            this._teleportTarget
        );


        this._teleportTarget = null;
    }


    teleportTo(position) {

        this._teleportTarget =
            position.clone();
    }


    // ============================================================
    // DEBUG
    // ============================================================

    _debugInput(
        source,
        stick,
        processedX,
        processedY
    ) {

        const now =
            performance.now();


        /*
         * Evita llenar la consola.
         */
        if (
            now -
            this._lastDebugTime <
            250
        ) {

            return;
        }


        this._lastDebugTime =
            now;


        console.log(
            '[XR INPUT]',
            {

                handedness:
                    source.handedness,

                profiles:
                    source.profiles,

                axes:
                    source.gamepad?.axes
                        ? Array.from(
                            source.gamepad.axes
                        )
                        : [],

                stickAxes:
                    stick.axes,

                stickX:
                    processedX,

                stickY:
                    processedY,

                buttons:
                    source.gamepad?.buttons
                        ? Array.from(
                            source.gamepad.buttons
                        ).map(
                            b => ({
                                pressed:
                                    b.pressed,

                                touched:
                                    b.touched,

                                value:
                                    b.value
                            })
                        )
                        : []
            }
        );
    }


    // ============================================================
    // API
    // ============================================================

    getRig() {

        return this.cameraRig;
    }


    // ============================================================
    // DISPOSE
    // ============================================================

    dispose() {

        for (
            const controller
            of this.controllers
        ) {

            this.scene.remove(
                controller
            );
        }


        this.controllers = [];


        if (
            this.camera.parent ===
            this.cameraRig
        ) {

            this.cameraRig.remove(
                this.camera
            );
        }


        if (
            this.cameraRig.parent ===
            this.scene
        ) {

            this.scene.remove(
                this.cameraRig
            );
        }
    }
}
