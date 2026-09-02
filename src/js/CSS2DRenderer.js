/**
 * CSS2DRenderer - Three.js addon
 * Adapted from three.js examples/jsm/renderers/CSS2DRenderer.js
 * Modified to use global THREE object (IIFE pattern) for compatibility
 * with projects using three.min.js as a script tag (not ES module).
 *
 * Source: https://github.com/mrdoob/three.js
 * License: MIT
 */
( function () {

    const _vector = new THREE.Vector3();
    const _viewMatrix = new THREE.Matrix4();
    const _viewProjectionMatrix = new THREE.Matrix4();
    const _a = new THREE.Vector3();
    const _b = new THREE.Vector3();

    class CSS2DObject extends THREE.Object3D {

        constructor( element = document.createElement( 'div' ) ) {
            super();
            this.isCSS2DObject = true;
            this.element = element;
            this.element.style.position = 'absolute';
            this.element.style.userSelect = 'none';
            this.element.setAttribute( 'draggable', false );
            this.center = new THREE.Vector2( 0.5, 0.5 );
            this.rotation2D = 0;

            this.addEventListener( 'removed', function () {
                this.traverse( function ( object ) {
                    if (
                        object.element &&
                        object.element instanceof object.element.ownerDocument.defaultView.Element &&
                        object.element.parentNode !== null
                    ) {
                        object.element.remove();
                    }
                } );
            } );
        }

        copy( source, recursive ) {
            super.copy( source, recursive );
            this.element = source.element.cloneNode( true );
            this.center = source.center;
            this.rotation2D = source.rotation2D;
            return this;
        }

    }

    class CSS2DRenderer {

        constructor( parameters = {} ) {
            const domElement = parameters.element !== undefined
                ? parameters.element
                : document.createElement( 'div' );

            domElement.style.overflow = 'hidden';
            this.domElement = domElement;

            this._width = 0;
            this._height = 0;
            this._widthHalf = 0;
            this._heightHalf = 0;

            const cache = { objects: new WeakMap() };

            this.getSize = function () {
                return { width: this._width, height: this._height };
            };

            this.render = function ( scene, camera ) {
                if ( scene.matrixWorldAutoUpdate === true ) scene.updateMatrixWorld();
                if ( camera.parent === null && camera.matrixWorldAutoUpdate === true ) camera.updateMatrixWorld();
                _viewMatrix.copy( camera.matrixWorldInverse );
                _viewProjectionMatrix.multiplyMatrices( camera.projectionMatrix, _viewMatrix );
                this.renderObject( scene, scene, camera );
                this.zOrder( scene );
            };

            this.renderObject = function ( object, scene, camera ) {
                if ( object.isCSS2DObject ) {
                    _vector.setFromMatrixPosition( object.matrixWorld );
                    _vector.applyMatrix4( _viewProjectionMatrix );
                    const visible = ( object.visible === true ) &&
                        ( _vector.z >= -1 && _vector.z <= 1 ) &&
                        ( object.layers.test( camera.layers ) === true );
                    const element = object.element;
                    element.style.display = ( visible === true ) ? '' : 'none';
                    if ( visible === true ) {
                        object.onBeforeRender( this, scene, camera );
                        const style = 'translate(' +
                            ( -100 * object.center.x ) + '%,' +
                            ( -100 * object.center.y ) + '%) ' +
                            'translate(' +
                            ( _vector.x * this._widthHalf + this._widthHalf ) + 'px,' +
                            ( -_vector.y * this._heightHalf + this._heightHalf ) + 'px)';
                        element.style.webkitTransform = style;
                        element.style.MozTransform = style;
                        element.style.oTransform = style;
                        element.style.transform = style;
                        if ( element.parentNode !== this.domElement ) {
                            this.domElement.appendChild( element );
                        }
                        object.onAfterRender( this, scene, camera );
                    }
                    cache.objects.set( object, {
                        distanceToCameraSquared: this.getDistanceToSquared( camera, object )
                    } );
                }
                for ( let i = 0, l = object.children.length; i < l; i++ ) {
                    this.renderObject( object.children[ i ], scene, camera );
                }
            };

            this.getDistanceToSquared = function ( object1, object2 ) {
                _a.setFromMatrixPosition( object1.matrixWorld );
                _b.setFromMatrixPosition( object2.matrixWorld );
                return _a.distanceToSquared( _b );
            };

            this.filterAndFlatten = function ( scene ) {
                const result = [];
                scene.traverse( function ( object ) {
                    if ( object.isCSS2DObject ) result.push( object );
                } );
                return result;
            };

            this.zOrder = function ( scene ) {
                const sorted = this.filterAndFlatten( scene ).sort( ( a, b ) => {
                    if ( a.renderOrder !== b.renderOrder ) return b.renderOrder - a.renderOrder;
                    const dA = cache.objects.get( a ).distanceToCameraSquared;
                    const dB = cache.objects.get( b ).distanceToCameraSquared;
                    return dA - dB;
                } );
                const zMax = sorted.length;
                for ( let i = 0, l = sorted.length; i < l; i++ ) {
                    sorted[ i ].element.style.zIndex = ( zMax - i ).toString();
                }
            };
        }

        setSize( width, height ) {
            this._width = width;
            this._height = height;
            this._widthHalf = this._width / 2;
            this._heightHalf = this._height / 2;
            this.domElement.style.width = width + 'px';
            this.domElement.style.height = height + 'px';
        }

    }

    // Expose on global THREE object
    THREE.CSS2DObject = CSS2DObject;
    THREE.CSS2DRenderer = CSS2DRenderer;

} )();
