import { describe, expect, test } from 'bun:test';
import { parseStep, readAssembly, solidInstances, applyXf, type V3 } from '../src/index';

// A cabinet product with two instances of one panel: the first where it is
// drawn, the second turned a quarter turn about Z and moved 100 mm along X.
const STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('test','',(''),(''),'','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#2=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#1))REPRESENTATION_CONTEXT('',''));
#10=PRODUCT('Cabinet','Cabinet','',());
#11=PRODUCT_DEFINITION_FORMATION('','',#10);
#12=PRODUCT_DEFINITION('','',#11,$);
#13=PRODUCT_DEFINITION_SHAPE('','',#12);
#14=SHAPE_REPRESENTATION('Cabinet',(#30,#31,#32),#2);
#15=SHAPE_DEFINITION_REPRESENTATION(#13,#14);
#20=PRODUCT('Panel','Panel','',());
#21=PRODUCT_DEFINITION_FORMATION('','',#20);
#22=PRODUCT_DEFINITION('','',#21,$);
#23=PRODUCT_DEFINITION_SHAPE('','',#22);
#24=SHAPE_REPRESENTATION('Panel',(#30),#2);
#25=SHAPE_DEFINITION_REPRESENTATION(#23,#24);
#26=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#27),#2);
#27=MANIFOLD_SOLID_BREP('Panel body',#28);
#28=CLOSED_SHELL('',());
#29=SHAPE_REPRESENTATION_RELATIONSHIP('','',#24,#26);
#30=AXIS2_PLACEMENT_3D('',#40,#41,#42);
#31=AXIS2_PLACEMENT_3D('',#40,#41,#42);
#32=AXIS2_PLACEMENT_3D('',#43,#41,#44);
#40=CARTESIAN_POINT('',(0.,0.,0.));
#41=DIRECTION('',(0.,0.,1.));
#42=DIRECTION('',(1.,0.,0.));
#43=CARTESIAN_POINT('',(100.,0.,0.));
#44=DIRECTION('',(0.,1.,0.));
#50=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','Left','',#12,#22,$);
#51=NEXT_ASSEMBLY_USAGE_OCCURRENCE('2','Right','',#12,#22,$);
#52=PRODUCT_DEFINITION_SHAPE('','',#50);
#53=PRODUCT_DEFINITION_SHAPE('','',#51);
#54=ITEM_DEFINED_TRANSFORMATION('','',#30,#31);
#55=ITEM_DEFINED_TRANSFORMATION('','',#30,#32);
#56=(REPRESENTATION_RELATIONSHIP('','',#24,#14)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#54)SHAPE_REPRESENTATION_RELATIONSHIP());
#57=(REPRESENTATION_RELATIONSHIP('','',#24,#14)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#55)SHAPE_REPRESENTATION_RELATIONSHIP());
#58=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#56,#52);
#59=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#57,#53);
#60=COLOUR_RGB('',0.5,0.25,1.);
#61=FILL_AREA_STYLE_COLOUR('',#60);
#62=STYLED_ITEM('',(#61),#27);
ENDSEC;
END-ISO-10303-21;
`;

describe('assembly', () => {
  const a = readAssembly(parseStep(STEP));

  test('the product tree with instance names', () => {
    expect(a.roots.map((r) => r.name)).toEqual(['Cabinet']);
    expect(a.roots[0].children.map((c) => [c.name, c.instance, c.solids.length])).toEqual([['Panel', 'Left', 1], ['Panel', 'Right', 1]]);
    expect(a.solidNames.get(27)).toBe('Panel body');
    expect(a.colors.get(27)).toEqual([0.5, 0.25, 1]);
  });

  test('each instance placed: the second turned a quarter turn and moved 100 mm', () => {
    const [left, right] = solidInstances(a);
    const p: V3 = [10, 0, 5];
    expect(applyXf(left.placement, p)).toEqual([10, 0, 5]);
    const q = applyXf(right.placement, p);
    expect(q[0]).toBeCloseTo(100, 9);
    expect(q[1]).toBeCloseTo(10, 9);
    expect(q[2]).toBeCloseTo(5, 9);
  });
});
