"use strict";
require("../base/base.js");
require("../base/range_utils.js");
require("../core/auditor.js");
require("../extras/chrome/cc/input_latency_async_slice.js");
require("./find_input_expectations.js");
require("./find_load_expectations.js");
require("./find_startup_expectations.js");
require("../model/event_info.js");
require("../model/ir_coverage.js");
require("../model/user_model/idle_expectation.js");

const log = require('../../../lib/log.js');

'use strict';
global.tr.exportTo('tr.importer', function() {
    var INSIGNIFICANT_MS = 1;

    function UserModelBuilder(model) {
        log.log('UserModelBuilder', 'Entering Constructor');
        this.model = model;
        this.modelHelper = model.getOrCreateHelper(tr.model.helpers.ChromeModelHelper);
        log.log('UserModelBuilder', 'Exiting Constructor');
    };
    UserModelBuilder.supportsModelHelper = function(modelHelper) {
        log.log('UserModelBuilder', 'supportsModelHelper');
        return modelHelper.browserHelper !== undefined;
    };
    UserModelBuilder.prototype = {
        buildUserModel: function() {
            log.log('UserModelBuilder', 'Entering buildUserModel');
            if (!this.modelHelper || !this.modelHelper.browserHelper) return;
            var expectations = undefined;
            try {
                expectations = this.findUserExpectations();
            } catch (error) {
                this.model.importWarning({
                    type: 'UserModelBuilder',
                    message: error,
                    showToUser: true
                });
                return;
            }
            expectations.forEach(function(expectation) {
                this.model.userModel.expectations.push(expectation);
            }, this);
            log.log('UserModelBuilder', 'Exiting buildUserModel');
        },
        findUserExpectations: function() {
            log.log('UserModelBuilder', 'Entering findUserExpectations');
            var expectations = [];
            expectations.push.apply(expectations, tr.importer.findStartupExpectations(this.modelHelper));
            expectations.push.apply(expectations, tr.importer.findLoadExpectations(this.modelHelper));
            expectations.push.apply(expectations, tr.importer.findInputExpectations(this.modelHelper));
            expectations.push.apply(expectations, this.findIdleExpectations(expectations));
            this.collectUnassociatedEvents_(expectations);
            log.log('UserModelBuilder', 'Exiting findUserExpectations');
            return expectations;
        },
        collectUnassociatedEvents_: function(rirs) {
            log.log('UserModelBuilder', 'Entering collectUnassociatedEvents_');
            var vacuumIRs = [];
            rirs.forEach(function(ir) {
                if (ir instanceof tr.model.um.IdleExpectation || ir instanceof tr.model.um.LoadExpectation || ir instanceof tr.model.um.StartupExpectation) vacuumIRs.push(ir);
            });
            if (vacuumIRs.length === 0) return;
            var allAssociatedEvents = tr.model.getAssociatedEvents(rirs);
            var unassociatedEvents = tr.model.getUnassociatedEvents(this.model, allAssociatedEvents);
            unassociatedEvents.forEach(function(event) {
                if (!(event instanceof tr.model.ThreadSlice)) return;
                if (!event.isTopLevel) return;
                for (var iri = 0; iri < vacuumIRs.length; ++iri) {
                    var ir = vacuumIRs[iri];
                    if (event.start >= ir.start && event.start < ir.end) {
                        ir.associatedEvents.addEventSet(event.entireHierarchy);
                        return;
                    }
                }
            });
            log.log('UserModelBuilder', 'Exiting collectUnassociatedEvents_');
        },
        findIdleExpectations: function(otherIRs) {
            log.log('UserModelBuilder', 'Entering findIdleExpectations');
            if (this.model.bounds.isEmpty) return;
            var emptyRanges = tr.b.findEmptyRangesBetweenRanges(tr.b.convertEventsToRanges(otherIRs), this.model.bounds);
            var irs = [];
            var model = this.model;
            emptyRanges.forEach(function(range) {
                if (range.max < range.min + INSIGNIFICANT_MS) return;
                irs.push(new tr.model.um.IdleExpectation(model, range.min, range.max - range.min));
            });
            log.log('UserModelBuilder', 'Exiting findIdleExpectations');
            return irs;
        }
    };

    function createCustomizeModelLinesFromModel(model) {
        log.log('UserModelBuilder', 'Entering createCustomizeModelLinesFromModel');
        var modelLines = [];
        modelLines.push('      audits.addEvent(model.browserMain,');
        modelLines.push('          {title: \'model start\', start: 0, end: 1});');
        var typeNames = {};
        for (var typeName in tr.e.cc.INPUT_EVENT_TYPE_NAMES) {
            typeNames[tr.e.cc.INPUT_EVENT_TYPE_NAMES[typeName]] = typeName;
        }
        var modelEvents = new tr.model.EventSet();
        model.userModel.expectations.forEach(function(ir, index) {
            modelEvents.addEventSet(ir.sourceEvents);
        });
        modelEvents = modelEvents.toArray();
        modelEvents.sort(tr.importer.compareEvents);
        modelEvents.forEach(function(event) {
            var startAndEnd = 'start: ' + parseInt(event.start) + ', ' + 'end: ' + parseInt(event.end) + '});';
            if (event instanceof tr.e.cc.InputLatencyAsyncSlice) {
                modelLines.push('      audits.addInputEvent(model, INPUT_TYPE.' + typeNames[event.typeName] + ',');
            } else if (event.title === 'RenderFrameImpl::didCommitProvisionalLoad') {
                modelLines.push('      audits.addCommitLoadEvent(model,');
            } else if (event.title === 'InputHandlerProxy::HandleGestureFling::started') {
                modelLines.push('      audits.addFlingAnimationEvent(model,');
            } else if (event.title === tr.model.helpers.IMPL_RENDERING_STATS) {
                modelLines.push('      audits.addFrameEvent(model,');
            } else if (event.title === tr.importer.CSS_ANIMATION_TITLE) {
                modelLines.push('      audits.addEvent(model.rendererMain, {');
                modelLines.push('        title: \'Animation\', ' + startAndEnd);
                return;
            } else {
                throw 'You must extend createCustomizeModelLinesFromModel()' + 'to support this event:\n' + event.title + '\n';
            }
            modelLines.push('          {' + startAndEnd);
        });
        modelLines.push('      audits.addEvent(model.browserMain,');
        modelLines.push('          {' + 'title: \'model end\', ' + 'start: ' + (parseInt(model.bounds.max) - 1) + ', ' + 'end: ' + parseInt(model.bounds.max) + '});');
        log.log('UserModelBuilder', 'Exiting createCustomizeModelLinesFromModel');
        return modelLines;
    }

    function createExpectedIRLinesFromModel(model) {
        log.log('UserModelBuilder', 'Entering createExpectedIRLinesFromModel');
        var expectedLines = [];
        var irCount = model.userModel.expectations.length;
        model.userModel.expectations.forEach(function(ir, index) {
            var irString = '      {';
            irString += 'title: \'' + ir.title + '\', ';
            irString += 'start: ' + parseInt(ir.start) + ', ';
            irString += 'end: ' + parseInt(ir.end) + ', ';
            irString += 'eventCount: ' + ir.sourceEvents.length;
            irString += '}';
            if (index < irCount - 1) irString += ',';
            expectedLines.push(irString);
        });
        log.log('UserModelBuilder', 'Exiting createExpectedIRLinesFromModel');
        return expectedLines;
    }

    function createIRFinderTestCaseStringFromModel(model) {
        log.log('UserModelBuilder', 'Entering createIRFinderTestCaseStringFromModel');
        var filename = window.location.hash.substr(1);
        var testName = filename.substr(filename.lastIndexOf('/') + 1);
        testName = testName.substr(0, testName.indexOf('.'));
        try {
            var testLines = [];
            testLines.push('  /*');
            testLines.push('    This test was generated from');
            testLines.push('    ' + filename + '');
            testLines.push('   */');
            testLines.push('  test(\'' + testName + '\', function() {');
            testLines.push('    var verifier = new UserExpectationVerifier();');
            testLines.push('    verifier.customizeModelCallback = function(model) {');
            testLines.push.apply(testLines, createCustomizeModelLinesFromModel(model));
            testLines.push('    };');
            testLines.push('    verifier.expectedIRs = [');
            testLines.push.apply(testLines, createExpectedIRLinesFromModel(model));
            testLines.push('    ];');
            testLines.push('    verifier.verify();');
            testLines.push('  });');
            var joined = testLines.join('\n');
            log.log('UserModelBuilder', 'Exiting createIRFinderTestCaseStringFromModel');
            return joined;
        } catch (error) {
            return error;
        }
    }
    return {
        UserModelBuilder: UserModelBuilder,
        createIRFinderTestCaseStringFromModel: createIRFinderTestCaseStringFromModel
    };
});
